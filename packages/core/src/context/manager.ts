import type { ChatMessage, ToolDef, Usage } from '../model.ts'
import type { TaggedEvent } from '../events.ts'
import { estimateRequestTokens, estimateTokens, truncateToolOutput } from './budget.ts'
import { compactMessages, compactMessagesAsync } from './compact.ts'
import { normalizeMessages } from './normalize.ts'
import { capMessage, createCheckpoint, reconstructContext, type ContextCheckpoint } from './checkpoint.ts'
import { DEFAULT_TOOL_OUTPUT_CHARS, type Summarizer, type TrimResult, type Truncated } from './types.ts'
import { TaskState, isTaskProjection } from '../task/index.ts'
import { restoreTaskState, taskProjection, withTaskProjection } from './task-state.ts'

/** 统一管理模型窗口的预算、工具结果和恢复策略。 */
export interface ContextManagerOptions {
  systemPrompt: string
  maxTokens?: number
  maxToolOutput?: number
  compact?: 'drop-middle' | 'tail' | 'summarize'
  summarizer?: Summarizer
  tools?: ToolDef[]
  outputReserveTokens?: number
  safetyMarginTokens?: number
}

/** 输入不可再裁剪时明确失败，避免把超限请求发送给提供方。 */
export class ContextBudgetError extends Error {
  constructor(readonly inputTokens: number, readonly inputLimit: number, readonly maxTokens: number) {
    super(`Estimated context budget exceeded: estimated input ${inputTokens} tokens exceeds available input budget ${inputLimit} of ${maxTokens}; provider token counts may differ`)
    this.name = 'ContextBudgetError'
  }
}

/** prepare 返回实际完整请求估算及分配给消息正文的预算。 */
export type PreparedContext = TrimResult & {
  inputTokens: number; messageBudget: number; outputReserveTokens: number
}

/** 用实际 prompt usage 校准仍然保留的请求前缀。 */
interface UsageBaseline { messages: string[]; correction: number }

/** 预算必须为有限整数，避免 NaN 或零输出上限绕过请求限制。 */
function validateBudget(name: string, value: number, minimum: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a finite integer >= ${minimum}`)
  }
}

/** 模型消息数组保持稳定引用，兼容现有调用方持有窗口的用法。 */
export class ContextManager {
  readonly messages: ChatMessage[] = []
  private baseline?: UsageBaseline
  private readonly maxToolOutput: number
  private readonly maxTokens: number
  private taskState = new TaskState()

  constructor(private readonly options: ContextManagerOptions) {
    this.maxToolOutput = options.maxToolOutput ?? DEFAULT_TOOL_OUTPUT_CHARS
    this.maxTokens = options.maxTokens ?? 24_000
    validateBudget('maxTokens', this.maxTokens, 1)
    validateBudget('maxToolOutput', this.maxToolOutput, 0)
    validateBudget('outputReserveTokens', this.outputReserve(), 1)
    validateBudget('safetyMarginTokens', options.safetyMarginTokens ?? 0, 0)
    this.messages.push({ role: 'system', content: options.systemPrompt })
  }

  /** 仅新加入的原始工具结果执行截断，既有窗口保持字节稳定。 */
  append(message: ChatMessage): ChatMessage {
    // 状态在工具截断前观察原文，独立于后续可丢弃的模型窗口。
    this.taskState.observe(message)
    const appended = capMessage(message, this.maxToolOutput)
    this.messages.push(appended)
    return appended
  }

  /** 预览同一截断策略的省略信息，供事件日志保留完整原文及 elided 元数据。 */
  previewToolOutput(text: string): Truncated {
    return truncateToolOutput(text, this.maxToolOutput)
  }

  /** 安装已经准备好的窗口，不对其工具消息重复截断。 */
  replace(messages: ChatMessage[]): void {
    const replacement = structuredClone(messages)
    this.messages.splice(0, this.messages.length, ...replacement)
    this.baseline = undefined
  }

  /** 使用实际 usage 的正向偏差，避免校准反而低估未知模型成本。 */
  observeUsage(usage: Usage, requestMessages: ChatMessage[]): void {
    const actual = usage.prompt_tokens
    if (actual === undefined || !Number.isFinite(actual) || actual < 0) return
    const estimated = estimateRequestTokens(requestMessages, this.options.tools)
    this.baseline = { messages: requestMessages.map((message) => JSON.stringify(message)),
      correction: Math.max(0, actual - estimated) }
  }

  /** 只有原请求前缀未被改写时才复用校准，压缩后重新依赖静态估算。 */
  private correction(messages: ChatMessage[]): number {
    const baseline = this.baseline
    if (!baseline || messages.length < baseline.messages.length) return 0
    const same = baseline.messages.every((message, index) => JSON.stringify(messages[index]) === message)
    if (!same) this.baseline = undefined
    return same ? baseline.correction : 0
  }

  /** 为模型输出预留显式上限，供请求参数与输入预算共同使用。 */
  private outputReserve(): number {
    return this.options.outputReserveTokens ?? Math.max(1, Math.min(4096, Math.floor(this.maxTokens * 0.15)))
  }

  /** 预留输出和误差空间，默认采用两万四千 token 的窗口。 */
  private inputLimit(): number {
    const safety = this.options.safetyMarginTokens ?? Math.min(512, Math.floor(this.maxTokens * 0.05))
    return Math.max(0, this.maxTokens - this.outputReserve() - safety)
  }

  /** 先规范化工具配对，再按完整请求预算压缩并验证最终窗口。 */
  async prepare(signal?: AbortSignal): Promise<PreparedContext> {
    signal?.throwIfAborted()
    const normalized = normalizeMessages(this.messages)
    const correction = this.correction(normalized)
    const overhead = estimateRequestTokens(normalized, this.options.tools) - estimateTokens(normalized)
    const messageBudget = Math.max(0, this.inputLimit() - overhead - correction)
    const result = await this.compactWindow(normalized, messageBudget, signal)
    signal?.throwIfAborted()
    // 压缩或规范化改变窗口后，原请求的 usage 校准失效。
    const changed = result.changed || JSON.stringify(result.messages) !== JSON.stringify(this.messages)
    const inputTokens = estimateRequestTokens(result.messages, this.options.tools)
      + (changed ? 0 : correction)
    if (inputTokens > this.inputLimit()) {
      throw new ContextBudgetError(inputTokens, this.inputLimit(), this.maxTokens)
    }
    if (changed) this.replace(result.messages)
    return { ...result, messages: this.messages, changed, inputTokens, messageBudget,
      outputReserveTokens: this.outputReserve() }
  }

  /** 来源投影只在压缩后启用，并在压缩前为自身预留完整成本。 */
  private async compactWindow(messages: ChatMessage[], messageBudget: number, signal?: AbortSignal): Promise<TrimResult> {
    const needsCompression = estimateTokens(messages) > messageBudget
    // 正常短上下文直接复用，避免每次请求都计算最小裁剪方案。
    if (!needsCompression && !messages.some(isTaskProjection)) {
      return compactMessages(messages, { maxTokens: messageBudget, signal })
    }
    const source = messages.filter((message) => !isTaskProjection(message))
    // 首条约束、最新输入和最新工具组不可被投影挤出窗口。
    const minimum = compactMessages(source, { maxTokens: 0, keepHead: this.options.compact !== 'tail' })
    const available = Math.max(0, messageBudget - estimateTokens(minimum.messages))
    const projection = needsCompression || messages.some(isTaskProjection)
      ? taskProjection(this.taskState, Math.min(900, Math.floor(messageBudget * 0.3), available)) : undefined
    const projectionCost = projection ? estimateRequestTokens([projection]) : 0
    const result = await compactMessagesAsync(source, {
      maxTokens: Math.max(0, messageBudget - projectionCost), keepHead: this.options.compact !== 'tail', signal,
      summarizer: this.options.compact === 'summarize' ? this.options.summarizer : undefined,
    })
    // 投影与摘要共享同一输入总预算，不能在验证后偷偷增加消息。
    if (projection) result.messages = withTaskProjection(result.messages, projection)
    result.tokens = estimateTokens(result.messages)
    return result
  }

  /** 恢复只替换模型窗口，后续新消息继续采用本次运行的配置。 */
  restore(events: TaggedEvent[], agentId = 'main'): void {
    const taskState = restoreTaskState(events, agentId)
    const messages = reconstructContext(events, this.options.systemPrompt, agentId, this.maxToolOutput)
    this.replace(messages)
    this.taskState = taskState
  }

  /** 保存实际窗口及当前运行策略，返回独立快照。 */
  checkpoint(): ContextCheckpoint {
    return createCheckpoint(this.messages, this.maxToolOutput, this.taskState.snapshot())
  }
}
