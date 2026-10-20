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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { cacheReadTokens, userContent } from './model.ts'
import {
  compactMessages,
  compactMessagesAsync,
  DEFAULT_TOOL_OUTPUT_CHARS,
  estimateTokens,
  truncateToolOutput,
  type Summarizer,
} from './context.ts'
import { makeSummarizer } from './compact.ts'
import { localFs, type FileSystem } from './fs.ts'
import type { ChatMessage, ToolCall } from './model.ts'
import type { Provider } from './provider.ts'
import { dispatch, makeTools, toolDefs, type Tool, type ToolContext, type ToolResult } from './tools.ts'
import { AgentLog, EventHub } from './events.ts'
import type { Sandbox } from './sandbox.ts'

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
  /** Last seq already recorded for this agent; a resumed run continues above it. */
  startSeq?: number
  /** OS-level confinement for the shell tool (none by default). */
  sandbox?: Sandbox
  /** Whether a sandboxed shell may reach the network. */
  network?: boolean
  tools?: Tool[]
  /** Nesting depth of this agent (root = 0). Sub-agents get depth + 1. */
  depth?: number
  /** Capability seam for the file tools; defaults to local disk rooted at `cwd`. */
  fs?: FileSystem
  /** Cap on a single tool result, in characters, applied when it is appended. */
  maxToolOutput?: number
  /**
   * How the window is compacted when it fills:
   *   `drop-middle` (default) — keep the head (constraints + cacheable prefix) and
   *                             the newest turns, drop the middle
   *   `tail`                  — keep only the newest turns (ablation; loses the head)
   *   `summarize`             — fold the dropped turns into one model-written recap
   */
  compact?: 'drop-middle' | 'tail' | 'summarize'
  /** Stop the run once the cumulative cost passes this many USD. */
  maxCost?: number
  /**
   * USD per 1M tokens, used to stamp `usage` events with a `cost`. `inputCached` is
   * the discounted rate for input served from the provider's prompt cache.
   */
  pricing?: { input: number; output: number; inputCached?: number }
}

export type ApprovalMode = 'suggest' | 'auto-edit' | 'full-auto'

export interface ApprovalRequest {
  id: string
  tool: string
  args: unknown
  agentId: string
}

export type ConfirmFn = (req: ApprovalRequest) => boolean | Promise<boolean>

const DEFAULT_SYSTEM = `You are a careful coding agent. Your workspace is {{cwd}}, and every file tool is sandboxed to it.

How to work:
- Inspect before you change: read a file, or list the directory, before editing it.
- Prefer small, targeted edits over rewrites, and leave unrelated code alone.
- Use the tools for facts — never guess file contents, paths or command output.
- Work autonomously: don't ask for confirmation and don't stop at a plan. Keep going until the task is actually done.
- Delegate self-contained subtasks with the \`task\` tool (a survey, a search, a parallel experiment). A sub-agent starts with a fresh context and returns only its final answer, so describe the subtask completely in its prompt.
- Web research: start with one search. Use at most 3 searches and 3 fetches unless the user asks for depth. Prefer snippets; fetch a page only when its snippet is not enough to answer. Never fetch the same URL twice. Leave \`maxChars\` unset — 20000 is already the cap.
- If something fails, say so plainly and report the error instead of pretending it worked.

When the task is complete, answer with a short summary: which files you changed and anything the user must know. No filler.`

/** Resolve the default system prompt for a working directory. */
export function defaultSystemPrompt(cwd: string): string {
  return withProjectInstructions(DEFAULT_SYSTEM.replace('{{cwd}}', cwd), cwd)
}

/** Cap on project instructions, in characters, so a huge file cannot crowd out the task. */
export const MAX_PROJECT_INSTRUCTIONS = 8_000

/**
 * The repository's own instructions, if any. `AGENTS.md` is the convention shared
 * by Codex, opencode and others, so a project keeps one file regardless of which
 * harness its contributors happen to use.
 */
export function projectInstructions(cwd: string): string {
  try {
    const text = readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8').trim()
    if (!text) return ''
    return text.length > MAX_PROJECT_INSTRUCTIONS
      ? `${text.slice(0, MAX_PROJECT_INSTRUCTIONS)}\n\n…(truncated; keep AGENTS.md short)`
      : text
  } catch {
    return ''
  }
}

/** Append `AGENTS.md` to a system prompt (a missing file leaves it untouched). */
export function withProjectInstructions(prompt: string, cwd: string): string {
  const extra = projectInstructions(cwd)
  return extra ? `${prompt}\n\nProject instructions (AGENTS.md; these override general defaults):\n\n${extra}` : prompt
}

export class Harness {
  readonly messages: ChatMessage[]
  readonly hub: EventHub
  readonly log: AgentLog
  readonly model: string
  readonly #provider: Provider
  readonly #tools: Tool[]
  readonly #system: string
  readonly #maxToolOutput: number
  readonly #compact: 'drop-middle' | 'tail' | 'summarize'
  readonly #summarizer?: Summarizer
  readonly #maxCost?: number
  #spent = 0
  readonly #toolCtx: ToolContext
  readonly #maxSteps: number
  readonly #maxContextTokens: number
  readonly #parallelTools: boolean
  readonly #approval: ApprovalMode
  readonly #confirm?: ConfirmFn
  readonly #pricing?: { input: number; output: number; inputCached?: number }

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
      sandbox: opts.sandbox,
      network: opts.network,
      // The filesystem the file tools run against: the injected provider, else
      // the real disk rooted at `cwd`. Sub-agents inherit their parent's.
      fs: opts.fs ?? localFs(opts.cwd),
    }
    this.#maxSteps = opts.maxSteps ?? 24
    this.#maxContextTokens = opts.maxContextTokens ?? 24_000
    this.#parallelTools = opts.parallelTools ?? true
    this.#approval = opts.approval ?? 'full-auto'
    this.#confirm = opts.confirm
    this.hub = opts.hub ?? new EventHub()
    this.log = new AgentLog(this.hub, opts.agentId ?? 'main', opts.parentId ?? null, opts.startSeq ?? 0)

    const system = opts.systemPrompt ?? defaultSystemPrompt(opts.cwd)
    this.#system = system
    this.#maxToolOutput = opts.maxToolOutput ?? DEFAULT_TOOL_OUTPUT_CHARS
    this.#compact = opts.compact ?? 'drop-middle'
    this.#summarizer = opts.compact === 'summarize' ? makeSummarizer(opts.provider, opts.model) : undefined
    this.#maxCost = opts.maxCost
    this.messages = [{ role: 'system', content: system }]
    this.log.emit({ type: 'session.start', model: this.model, cwd: opts.cwd, parentId: opts.parentId ?? null })
  }

  /** Run one user turn to completion; returns the final assistant text. */
  async send(
    prompt: string,
    signal?: AbortSignal,
    images?: Array<{ mimeType: string; data: string }>,
  ): Promise<string> {
    this.#toolCtx.signal = signal
    this.messages.push({ role: 'user', content: userContent(prompt, images) })
    this.log.emit({ type: 'user.message', text: prompt })

    for (let step = 1; step <= this.#maxSteps; step++) {
      this.log.emit({ type: 'turn.start', turn: step })
      let streamedText = false

      const trim =
        this.#compact === 'summarize'
          ? await compactMessagesAsync(this.messages, { maxTokens: this.#maxContextTokens, summarizer: this.#summarizer })
          : compactMessages(this.messages, {
              maxTokens: this.#maxContextTokens,
              keepHead: this.#compact !== 'tail',
            })
      const { messages, dropped, tokens, strategy } = trim
      if (dropped > 0) {
        this.messages.splice(0, this.messages.length, ...messages)
        this.log.emit({
          type: 'context.trim',
          dropped,
          tokens,
          strategy,
        })
      }

      // The Inspector: record exactly what this turn hands to the model, after
      // trimming. Shallow-copy the array so a later push cannot rewrite history.
      this.log.emit({
        type: 'model.request',
        model: this.model,
        system: this.#system,
        tools: this.#tools.map((t) => t.name),
        messages: [...this.messages],
        tokens: estimateTokens(this.messages),
      })

      const { message, usage } = await this.#provider.chat({
        model: this.model,
        messages: this.messages,
        tools: toolDefs(this.#tools),
        signal,
        onDelta: (delta) => {
          if (delta.type === 'text') {
            streamedText = true
            this.log.emit({ type: 'text.delta', text: delta.text })
          } else {
            this.log.emit({ type: 'thinking.delta', text: delta.text })
          }
        },
      })
      this.messages.push(message)
      if (usage) {
        const input = usage.prompt_tokens ?? 0
        const output = usage.completion_tokens ?? 0
        const cacheRead = cacheReadTokens(usage)
        const price = this.#pricing
        if (price) {
          this.#spent +=
            ((input - cacheRead) / 1e6) * price.input +
            (cacheRead / 1e6) * (price.inputCached ?? price.input) +
            (output / 1e6) * price.output
        }
        this.log.emit({
          type: 'usage',
          input,
          output,
          // Only when the provider actually reported a hit, so events stay small.
          ...(cacheRead > 0 ? { cacheRead } : {}),
          cost: price
            ? ((input - cacheRead) / 1e6) * price.input +
              (cacheRead / 1e6) * (price.inputCached ?? price.input) +
              (output / 1e6) * price.output
            : undefined,
        })
      }
      // Budget breaker: a run must not be able to spend without limit.
      if (this.#maxCost !== undefined && this.#spent > this.#maxCost) {
        const text = `stopped: cost budget of $${this.#maxCost} exceeded (spent $${this.#spent.toFixed(6)})`
        this.log.emit({ type: 'error', message: text, fatal: true })
        this.log.emit({ type: 'turn.end', stopReason: 'budget', text })
        return text
      }

      if (message.content && !streamedText) this.log.emit({ type: 'text.delta', text: String(message.content) })

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
        return name === 'bash' || !!tool?.network
      case 'suggest':
        return !!tool?.mutating || !!tool?.network
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
      this.log.emit({
        type: 'tool.call',
        id: call.id,
        name,
        args,
        ...(this.#toolCtx.sandbox ? { sandbox: this.#toolCtx.sandbox.kind } : {}),
      })

      if (this.#needsApproval(name)) {
        const id = `perm:${call.id}`
        this.log.emit({
          type: 'permission.request',
          id,
          tool: name,
          args,
          ...(this.#toolCtx.sandbox ? { sandbox: this.#toolCtx.sandbox.kind } : {}),
        })
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
      // Cap the result *now*, not at trim time: a stable prefix is what lets the
      // provider's prompt cache hit, and rewriting history would throw it away.
      const capped = truncateToolOutput(result.output, this.#maxToolOutput)
      this.log.emit({
        type: 'tool.result',
        id: call.id,
        name,
        ok: !result.isError,
        output: result.output,
        ms: Date.now() - started,
        ...(capped.elided > 0 ? { elided: capped.elided } : {}),
      })
      return { call, result: { ...result, output: capped.text } }
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
