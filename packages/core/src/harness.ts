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
  hub?: EventHub
  agentId?: string
  parentId?: string | null
  tools?: Tool[]
}

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

  constructor(opts: HarnessOptions) {
    this.#provider = opts.provider
    this.model = opts.model
    this.#tools = opts.tools ?? makeTools()
    this.#toolCtx = { cwd: opts.cwd, allowBash: !!opts.allowBash }
    this.#maxSteps = opts.maxSteps ?? 24
    this.#maxContextTokens = opts.maxContextTokens ?? 24_000
    this.#parallelTools = opts.parallelTools ?? true
    this.hub = opts.hub ?? new EventHub()
    this.log = new AgentLog(this.hub, opts.agentId ?? 'main', opts.parentId ?? null)

    const system = (opts.systemPrompt ?? DEFAULT_SYSTEM).replace('{{cwd}}', opts.cwd)
    this.messages = [{ role: 'system', content: system }]
    this.log.emit({ type: 'session.start', model: this.model, cwd: opts.cwd })
  }

  /** Run one user turn to completion; returns the final assistant text. */
  async send(prompt: string, signal?: AbortSignal): Promise<string> {
    this.messages.push({ role: 'user', content: prompt })

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
        this.log.emit({
          type: 'usage',
          input: usage.prompt_tokens ?? 0,
          output: usage.completion_tokens ?? 0,
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
