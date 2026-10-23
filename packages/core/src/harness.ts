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
import { cacheReadTokens, reasoningTokens, userContent } from './model.ts'
import { ContextManager, makeSummarizer, type TrimResult } from './context/index.ts'
import { localFs, type FileSystem } from './fs.ts'
import type { ChatMessage, ToolCall, Usage } from './model.ts'
import { providerCapabilityError, type ChatRequest, type Provider } from './provider.ts'
import { dispatch, makeTools, toolDefs, type Tool, type ToolContext, type ToolResult } from './tools.ts'
import { AgentLog, EventHub, type TaggedEvent } from './events.ts'
import type { Sandbox } from './sandbox.ts'
import type { RunBudget } from './runtime/budget.ts'

export interface HarnessOptions {
  provider: Provider
  model: string
  cwd: string
  allowBash?: boolean
  maxSteps?: number
  /** 完整请求的估算预算，包含输出预留和安全余量。 */
  maxContextTokens?: number
  /** 模型输出预留；默认最多 4096 tokens，且不超过总预算的 15%。 */
  contextOutputReserveTokens?: number
  /** 本地粗估安全余量；默认最多 512 tokens，且不超过总预算的 5%。 */
  contextSafetyMarginTokens?: number
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
   * 工作窗口压缩策略：drop-middle 优先保留首轮约束和近期步骤，
   * tail 仅保留近期内容，summarize 将移除历史转为有界交接摘要。
   * 三种策略均由 ContextManager 在发送前检查完整请求估算预算。
   */
  compact?: 'drop-middle' | 'tail' | 'summarize'
  /** Stop the run once the cumulative cost passes this many USD. */
  maxCost?: number
  /** 与同一 Run 的子 Agent 共享预算。 */
  budget?: RunBudget
  /** 从持久化执行账本恢复的未知调用，必须人工确认后才能重试。 */
  blockedToolIds?: ReadonlySet<string>
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
  /** 当前工具调用的取消信号。 */
  signal?: AbortSignal
}

export type ConfirmFn = (req: ApprovalRequest) => boolean | Promise<boolean>

const DEFAULT_SYSTEM = `You are a careful coding agent. Your workspace is {{cwd}}, and every file tool is sandboxed to it.

How to work:
- Inspect before you change: read a file, or list the directory, before editing it.
- Prefer \`edit_file\` for targeted changes (it fails on an ambiguous match); use \`write_file\` for new files or full rewrites. Leave unrelated code alone.
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

/** 驱动模型和工具执行，所有模型窗口状态交由 ContextManager 管理。 */
export class Harness {
  /** 兼容历史观察入口；内部修改与恢复均通过 ContextManager。 */
  readonly messages: ChatMessage[]
  readonly hub: EventHub
  readonly log: AgentLog
  readonly model: string
  readonly #provider: Provider
  readonly #tools: Tool[]
  readonly #system: string
  readonly #context: ContextManager
  readonly #maxCost?: number
  #spent = 0
  readonly #toolCtx: ToolContext
  readonly #maxSteps: number
  readonly #parallelTools: boolean
  readonly #approval: ApprovalMode
  readonly #confirm?: ConfirmFn
  readonly #pricing?: { input: number; output: number; inputCached?: number }
  readonly #budget?: RunBudget
  /** 当前运行内按模型调用 ID 记录已完成结果，避免恢复/重试重复副作用。 */
  readonly #completedTools = new Map<string, ToolResult>()
  readonly #blockedToolIds: ReadonlySet<string>
  #mutationTail: Promise<void> = Promise.resolve()

  constructor(opts: HarnessOptions) {
    this.#provider = opts.provider
    this.model = opts.model
    this.#tools = opts.tools ?? makeTools()
    this.#pricing = opts.pricing
    this.#budget = opts.budget
    this.#blockedToolIds = opts.blockedToolIds ?? new Set()
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
    this.#parallelTools = opts.parallelTools ?? true
    this.#approval = opts.approval ?? 'full-auto'
    this.#confirm = opts.confirm
    this.hub = opts.hub ?? new EventHub()
    this.log = new AgentLog(this.hub, opts.agentId ?? 'main', opts.parentId ?? null, opts.startSeq ?? 0)

    const system = opts.systemPrompt ?? defaultSystemPrompt(opts.cwd)
    this.#system = system
    this.#maxCost = opts.maxCost
    this.#context = this.#createContext(opts, system)
    this.messages = this.#context.messages
    this.log.emit({ type: 'session.start', model: this.model, cwd: opts.cwd, parentId: opts.parentId ?? null })
  }

  /** 创建工作窗口，摘要用量走与普通请求相同的计费入口。 */
  #createContext(opts: HarnessOptions, systemPrompt: string): ContextManager {
    const summarizer = opts.compact === 'summarize'
      ? makeSummarizer(opts.provider, opts.model, {
          maxInputTokens: Math.max(1, Math.floor((opts.maxContextTokens ?? 24_000) * 0.8)),
          onUsage: (usage, durationMs) => this.#recordUsage(usage, durationMs, 'summary'),
        })
      : undefined
    return new ContextManager({
      systemPrompt, maxTokens: opts.maxContextTokens ?? 24_000,
      maxToolOutput: opts.maxToolOutput, compact: opts.compact, summarizer,
      tools: toolDefs(this.#tools), outputReserveTokens: opts.contextOutputReserveTokens,
      safetyMarginTokens: opts.contextSafetyMarginTokens,
    })
  }

  /** 从事件恢复工作窗口；原始日志与快照规则由上下文模块统一处理。 */
  restore(events: TaggedEvent[]): void {
    this.#context.restore(events, this.log.agentId)
  }

  /** 添加用户输入并驱动步骤，不直接改写上下文消息数组。 */
  async send(prompt: string, signal?: AbortSignal, images?: Array<{ mimeType: string; data: string }>): Promise<string> {
    signal?.throwIfAborted()
    this.#toolCtx.signal = signal
    this.#context.append({ role: 'user', content: userContent(prompt, images) })
    this.log.emit({ type: 'user.message', text: prompt, ...(images?.length ? { images } : {}) })
    // 每步的窗口准备、模型调用和工具执行各自承担单一职责。
    for (let step = 1; step <= this.#maxSteps; step++) {
      const result = await this.#runStep(step, signal)
      if (result !== undefined) return result
    }
    return this.#finish('(reached the step limit without a final answer)', 'max_steps')
  }

  /** 在完整工具步骤之间准备窗口，预算失败时不调用模型。 */
  async #runStep(step: number, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted()
    const existingLimit = this.#costLimit()
    if (existingLimit) return this.#finish(existingLimit, 'budget')
    this.log.emit({ type: 'turn.start', turn: step })
    const prepared = await this.#context.prepare(signal)
    // 摘要也可能耗尽费用预算，必须在正式请求前再次检查。
    const summaryLimit = this.#costLimit()
    if (summaryLimit) return this.#finish(summaryLimit, 'budget')
    this.#recordContext(prepared)
    // 只在压缩改变窗口时保存请求前快照，避免逐请求重复存储完整历史。
    if (prepared.changed) this.#checkpoint()
    const { message, streamedText } = await this.#requestModel(prepared.outputReserveTokens, signal)
    // 提供方忽略取消信号时也不能在迟到响应后执行工具。
    signal?.throwIfAborted()
    this.#context.append(message)
    const modelLimit = this.#costLimit()
    if (modelLimit) return this.#finish(modelLimit, 'budget')
    if (message.content && !streamedText) this.log.emit({ type: 'text.delta', text: String(message.content) })
    // 没有工具调用时结束当前用户轮；否则完整执行后保存窗口。
    const calls = message.tool_calls ?? []
    if (calls.length === 0) return this.#finish(String(message.content ?? ''), 'stop')
    await this.#runTools(calls)
    this.#checkpoint()
  }

  /** 记录真实压缩与模型输入；快照不受后续消息修改影响。 */
  #recordContext(prepared: TrimResult & { inputTokens: number }): void {
    if (prepared.changed) {
      this.log.emit({ type: 'context.trim', dropped: prepared.dropped, tokens: prepared.tokens, strategy: prepared.strategy })
    }
    this.log.emit({
      type: 'model.request', model: this.model, system: this.#system,
      tools: this.#tools.map((tool) => tool.name), messages: structuredClone(this.messages),
      tokens: prepared.inputTokens,
    })
  }

  /** 模型请求只消费已准备窗口，用量同时反馈给估算器和费用统计。 */
  async #requestModel(maxTokens: number, signal?: AbortSignal): Promise<{ message: ChatMessage; streamedText: boolean }> {
    let streamedText = false
    const messages = structuredClone(this.messages)
    const started = Date.now()
    const request: ChatRequest = {
      model: this.model, messages, tools: toolDefs(this.#tools), signal, maxTokens,
      onDelta: (delta) => {
        if (delta.type === 'text') streamedText = true
        this.log.emit({ type: delta.type === 'text' ? 'text.delta' : 'thinking.delta', text: delta.text })
      },
    }
    const capabilityError = providerCapabilityError(this.#provider, request)
    if (capabilityError) throw new Error(capabilityError)
    const { message, usage } = await this.#provider.chat(request)
    if (usage) {
      this.#context.observeUsage(usage, messages)
      this.#recordUsage(usage, Date.now() - started)
    }
    return { message, streamedText }
  }

  /** 普通生成与摘要共用费用计算，保持现有 usage 事件字段。 */
  #recordUsage(usage: Usage, durationMs: number, purpose?: 'summary'): void {
    const input = usage.prompt_tokens ?? 0
    const output = usage.completion_tokens ?? 0
    const cacheRead = cacheReadTokens(usage)
    const reasoning = reasoningTokens(usage)
    const price = this.#pricing
    const cost = price
      ? ((input - cacheRead) / 1e6) * price.input + (cacheRead / 1e6) * (price.inputCached ?? price.input) + (output / 1e6) * price.output
      : undefined
    this.#spent += cost ?? 0
    this.#budget?.consume(input, output, cost ?? 0)
    this.log.emit({
      type: 'usage', input, output, model: this.model, durationMs,
      ...(cacheRead > 0 ? { cacheRead } : {}), ...(reasoning > 0 ? { reasoning } : {}),
      ...(cost !== undefined ? { cost } : {}), ...(purpose ? { purpose } : {}),
    })
  }

  /** 超过费用上限时沿用原有可见失败与停止原因。 */
  #costLimit(): string | undefined {
    const exceeded = this.#budget?.exceeded() || (this.#maxCost !== undefined && this.#spent > this.#maxCost)
    if (!exceeded) return undefined
    const snapshot = this.#budget?.snapshot()
    if (snapshot?.reason === 'tokens') {
      const text = `stopped: token budget of ${snapshot.maxTokens} exceeded (spent ${snapshot.input + snapshot.output})`
      this.log.emit({ type: 'error', message: text, fatal: true })
      return text
    }
    const limit = snapshot?.maxCost ?? this.#maxCost ?? 0
    const spent = snapshot?.cost ?? this.#spent
    const text = `stopped: cost budget of $${limit} exceeded (spent $${spent.toFixed(6)})`
    this.log.emit({ type: 'error', message: text, fatal: true })
    return text
  }

  /** 在事件流中持久化当前模型工作窗口，存储层只负责写入。 */
  #checkpoint(): void {
    this.log.emit({ type: 'context.checkpoint', checkpoint: this.#context.checkpoint() })
  }

  /** 完成事件后保存窗口，恢复时不会再次追加已收录的最终回复。 */
  #finish(text: string, stopReason: string): string {
    this.log.emit({ type: 'turn.end', stopReason, text })
    this.#checkpoint()
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

  /** 读取写入前内容，仅用于现有审批预览，不影响上下文压缩。 */
  async #preview(name: string, args: unknown): Promise<{ before?: string } | undefined> {
    if (!['write_file', 'edit_file'].includes(name) || !this.#toolCtx.fs) return undefined
    const target = (args as { path?: unknown })?.path
    if (typeof target !== 'string' || !target) return undefined
    try {
      const before = await this.#toolCtx.fs.read(this.#toolCtx.fs.resolve(target))
      return { before: before.length > 200_000 ? before.slice(0, 200_000) : before }
    } catch {
      // 新文件或不可读目标没有可展示的预览。
      return undefined
    }
  }

  /** 保留原有审批语义，确认异常按拒绝处理。 */
  async #approve(call: ToolCall, args: unknown): Promise<boolean> {
    this.#toolCtx.signal?.throwIfAborted()
    const name = call.function.name
    if (!this.#needsApproval(name)) return true
    const id = `perm:${call.id}`
    const preview = await this.#preview(name, args)
    this.log.emit({
      type: 'permission.request', id, tool: name, args,
      ...(this.#toolCtx.sandbox ? { sandbox: this.#toolCtx.sandbox.kind } : {}),
      ...(preview ? { preview } : {}),
    })
    let decision: 'allow' | 'deny' = 'deny'
    try {
      if (this.#confirm && await this.#confirm({ id, tool: name, args, agentId: this.log.agentId, signal: this.#toolCtx.signal })) decision = 'allow'
    } catch {
      // 确认失败不能放行工具。
      decision = 'deny'
    }
    this.log.emit({ type: 'permission.result', id, decision })
    return decision === 'allow'
  }

  /** 执行工具并记录完整结果，截断统一留给 ContextManager。 */
  async #runOne(call: ToolCall): Promise<{ call: ToolCall; result: ToolResult }> {
    const name = call.function?.name ?? ''
    let args: unknown = {}
    try {
      args = JSON.parse(call.function?.arguments || '{}')
    } catch {
      // 参数格式错误仍交给原有 dispatch 返回可见工具错误。
    }
    this.log.emit({
      type: 'tool.call', id: call.id, name, args,
      ...(this.#toolCtx.sandbox ? { sandbox: this.#toolCtx.sandbox.kind } : {}),
    })
    if (this.#blockedToolIds.has(call.id)) {
      const result = { output: `tool call ${call.id} has unknown side effects from a previous run; review before retrying`, isError: true }
      this.log.emit({ type: 'tool.status', id: call.id, name, status: 'failed', reason: 'recovery_requires_review' })
      this.log.emit({ type: 'tool.result', id: call.id, name, ok: false, output: result.output, ms: 0 })
      return { call, result }
    }
    const previous = this.#completedTools.get(call.id)
    if (previous) {
      // 已有确定结果时只回放结果，不再次触发文件、shell 或外部服务副作用。
      this.log.emit({ type: 'tool.status', id: call.id, name, status: previous.isError ? 'failed' : 'succeeded', reason: 'replayed_result' })
      this.log.emit({ type: 'tool.result', id: call.id, name, ok: !previous.isError, output: previous.output, ms: 0 })
      return { call, result: previous }
    }
    this.log.emit({ type: 'tool.status', id: call.id, name, status: 'planned' })
    const allowed = await this.#approve(call, args)
    this.#toolCtx.signal?.throwIfAborted()
    if (!allowed) this.log.emit({ type: 'tool.status', id: call.id, name, status: 'failed', reason: 'approval_denied' })
    if (allowed) this.log.emit({ type: 'tool.status', id: call.id, name, status: 'approved' })
    const started = Date.now()
    let result: ToolResult
    let dispatched = false
    try {
      if (!allowed) result = { output: `denied by approval policy: ${name}`, isError: true }
      else {
        dispatched = true
        this.log.emit({ type: 'tool.status', id: call.id, name, status: 'started' })
        const release = await this.#acquireMutation(name)
        try {
          result = await dispatch(this.#tools, name, call.function?.arguments || '{}', this.#toolCtx)
        } finally {
          release()
        }
        // dispatch 会把工具异常转换成结果；取消需要单独抛出，避免把未确认的副作用伪装成普通失败。
        if (this.#toolCtx.signal?.aborted) this.#toolCtx.signal.throwIfAborted()
      }
    } catch (err) {
      if (this.#toolCtx.signal?.aborted) {
        this.log.emit({ type: 'tool.status', id: call.id, name, status: dispatched ? 'unknown' : 'cancelled', reason: dispatched ? 'cancelled_after_dispatch' : 'cancelled_before_dispatch' })
      }
      throw err
    }
    // 事件保留完整原文与省略量，实际入窗截断仍由 ContextManager 负责。
    const { elided } = this.#context.previewToolOutput(result.output)
    this.log.emit({ type: 'tool.result', id: call.id, name, ok: !result.isError,
      output: result.output, ms: allowed ? Date.now() - started : 0,
      ...(elided > 0 ? { elided } : {}),
    })
    this.log.emit({ type: 'tool.status', id: call.id, name, status: result.isError ? 'failed' : 'succeeded' })
    this.#completedTools.set(call.id, result)
    return { call, result }
  }

  /** 只锁定会改变工作区或触发外部副作用的工具，读工具仍可并行。 */
  async #acquireMutation(name: string): Promise<() => void> {
    const tool = this.#tools.find((item) => item.name === name)
    if (!tool?.mutating) return () => undefined
    const previous = this.#mutationTail
    let release!: () => void
    this.#mutationTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    return release
  }

  /** 保留既有并发策略，按调用顺序把原始结果交给上下文模块。 */
  async #runTools(calls: ToolCall[]): Promise<void> {
    const settled: Array<{ call: ToolCall; result: ToolResult }> = []
    if (this.#parallelTools && calls.length > 1) {
      settled.push(...await Promise.all(calls.map((call) => this.#runOne(call))))
    } else {
      // 串行模式等待前一工具完成后再执行下一条。
      for (const call of calls) settled.push(await this.#runOne(call))
    }
    for (const { call, result } of settled) {
      this.#context.append({ role: 'tool', tool_call_id: call.id, name: call.function?.name ?? '', content: result.output })
    }
  }
}
