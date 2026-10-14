/**
 * The agent loop — now event-driven.
 *
 *   user → model → (tool calls? run them → feed results back) → … → final answer
 *
 * The loop no longer "returns output": it emits `AgentEvent`s into an `EventHub`.
 * The CLI, the server's SSE stream, the session JSONL and the trace are all just
 * consumers of that stream. Tool calls in one assistant message run concurrently
 * unless `parallelTools` is disabled, and a tool failure is fed back as a normal
 * message so the model can recover.
 */

import { estimateTokens, trimMessages } from './context.ts'
import type { ChatMessage, ToolCall } from './model.ts'
import type { Provider } from './provider.ts'
import { dispatch, makeTools, toolDefs, type Tool, type ToolContext, type ToolResult } from './tools.ts'
import { AgentLog, EventHub } from './events.ts'

export interface HarnessOptions {
  provider: Provider
  model: string
  cwd: string
  allowBash?: boolean
  maxSteps?: number
  maxContextTokens?: number
  systemPrompt?: string
  /** Run the tool calls of one assistant message concurrently (default true). */
  parallelTools?: boolean
  /** When tools need approval: suggest = any mutating, auto-edit = bash only, full-auto = never. */
  approval?: ApprovalMode
  /** Asked when a tool call needs approval; failing/absent means deny. */
  confirm?: ConfirmFn
  hub?: EventHub
  agentId?: string
  parentId?: string | null
  tools?: Tool[]
  /** Nesting depth of this agent (root = 0). Sub-agents get depth + 1. */
  depth?: number
  /** USD per 1M tokens, used to stamp `usage` events with a `cost`. */
  pricing?: { input: number; output: number }
}

export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto'

export interface ApprovalRequest {
  id: string
  tool: string
  args: unknown
  agentId: string
}

export type ConfirmFn = (req: ApprovalRequest) => boolean | Promise<boolean>

const DEFAULT_SYSTEM = `You are a careful coding agent working inside the directory {{cwd}}.
Use the provided tools to inspect and modify files; prefer reading a file before writing it.
Work autonomously — do not ask for confirmation. When the task is complete, reply with a short summary of what you did.`

export class Harness {
  readonly messages: ChatMessage[]
  readonly hub: EventHub
  readonly log: AgentLog
  readonly model: string
  readonly #provider: Provider
  readonly #tools: Tool[]
  readonly #toolCtx: ToolContext
  readonly #maxSteps: number
  readonly #maxContextTokens: number
  readonly #parallelTools: boolean
  readonly #approval: ApprovalMode
  readonly #confirm?: ConfirmFn
  readonly #pricing?: { input: number; output: number }

  constructor(opts: HarnessOptions) {
    this.#provider = opts.provider
    this.model = opts.model
    this.#tools = opts.tools ?? makeTools()
    this.#pricing = opts.pricing
    this.#toolCtx = {
      cwd: opts.cwd,
      allowBash: !!opts.allowBash,
      agentId: opts.agentId ?? 'main',
      depth: opts.depth ?? 0,
    }
    this.#maxSteps = opts.maxSteps ?? 24
    this.#maxContextTokens = opts.maxContextTokens ?? 24_000
    this.#parallelTools = opts.parallelTools ?? true
    this.#approval = opts.approval ?? 'full-auto'
    this.#confirm = opts.confirm
    this.hub = opts.hub ?? new EventHub()
    this.log = new AgentLog(this.hub, opts.agentId ?? 'main', opts.parentId ?? null)

    const system = (opts.systemPrompt ?? DEFAULT_SYSTEM).replace('{{cwd}}', opts.cwd)
    this.messages = [{ role: 'system', content: system }]
    this.log.emit({ type: 'session.start', model: this.model, cwd: opts.cwd, parentId: opts.parentId ?? null })
  }

  /** Run one user turn to completion; returns the final assistant text. */
  async send(prompt: string, signal?: AbortSignal): Promise<string> {
    this.#toolCtx.signal = signal
    this.messages.push({ role: 'user', content: prompt })
    this.log.emit({ type: 'user.message', text: prompt })

    for (let step = 1; step <= this.#maxSteps; step++) {
      this.log.emit({ type: 'turn.start', turn: step })

      const { messages, dropped } = trimMessages(this.messages, this.#maxContextTokens)
      if (dropped > 0) {
        this.messages.splice(0, this.messages.length, ...messages)
        this.log.emit({
          type: 'context.trim',
          dropped,
          tokens: estimateTokens(messages),
          strategy: 'window',
        })
      }

      const { message, usage } = await this.#provider.chat({
        model: this.model,
        messages: this.messages,
        tools: toolDefs(this.#tools),
        signal,
      })
      this.messages.push(message)
      if (usage) {
        const input = usage.prompt_tokens ?? 0
        const output = usage.completion_tokens ?? 0
        this.log.emit({
          type: 'usage',
          input,
          output,
          cost: this.#pricing ? (input / 1e6) * this.#pricing.input + (output / 1e6) * this.#pricing.output : undefined,
        })
      }
      if (message.content) this.log.emit({ type: 'text.delta', text: String(message.content) })

      const calls = message.tool_calls ?? []
      if (calls.length === 0) {
        const text = String(message.content ?? '')
        this.log.emit({ type: 'turn.end', stopReason: 'stop', text })
        return text
      }

      await this.#runTools(calls)
    }

    const text = '(reached the step limit without a final answer)'
    this.log.emit({ type: 'turn.end', stopReason: 'max_steps', text })
    return text
  }

  #needsApproval(name: string): boolean {
    const tool = this.#tools.find((t) => t.name === name)
    switch (this.#approval) {
      case 'full-auto':
        return false
      case 'auto-edit':
        return name === 'bash'
      case 'suggest':
        return !!tool?.mutating
    }
  }

  async #runTools(calls: ToolCall[]): Promise<void> {
    const runOne = async (call: ToolCall): Promise<{ call: ToolCall; result: ToolResult }> => {
      const name = call.function?.name ?? ''
      let args: unknown = {}
      try {
        args = JSON.parse(call.function?.arguments || '{}')
      } catch {
        /* keep the raw string in the event */
      }
      this.log.emit({ type: 'tool.call', id: call.id, name, args })

      if (this.#needsApproval(name)) {
        const id = `perm:${call.id}`
        this.log.emit({ type: 'permission.request', id, tool: name, args })
        let decision: 'allow' | 'deny' = 'deny'
        try {
          if (this.#confirm && (await this.#confirm({ id, tool: name, args, agentId: this.log.agentId }))) {
            decision = 'allow'
          }
        } catch {
          decision = 'deny'
        }
        this.log.emit({ type: 'permission.result', id, decision })
        if (decision === 'deny') {
          this.log.emit({
            type: 'tool.result',
            id: call.id,
            name,
            ok: false,
            output: `denied by approval policy: ${name}`,
            ms: 0,
          })
          return { call, result: { output: `denied by approval policy: ${name}`, isError: true } }
        }
      }

      const started = Date.now()
      const result = await dispatch(this.#tools, name, call.function?.arguments || '{}', this.#toolCtx)
      this.log.emit({
        type: 'tool.result',
        id: call.id,
        name,
        ok: !result.isError,
        output: result.output,
        ms: Date.now() - started,
      })
      return { call, result }
    }

    const settled =
      this.#parallelTools && calls.length > 1
        ? await Promise.all(calls.map(runOne))
        : await calls.reduce<Promise<Array<{ call: ToolCall; result: ToolResult }>>>(
            async (accP, call) => {
              const acc = await accP
              acc.push(await runOne(call))
              return acc
            },
            Promise.resolve([]),
          )

    for (const { call, result } of settled) {
      this.messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function?.name ?? '',
        content: result.output,
      })
    }
  }
}
