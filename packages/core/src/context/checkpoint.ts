import type { TaggedEvent } from '../events.ts'
import { truncateToolOutput } from './budget.ts'
import { userContent, type ChatMessage, type ToolCall } from '../model.ts'
import { validateTaskState, type TaskStateSnapshot } from '../task/index.ts'

/** 保存实际模型窗口及原始工具结果的截断策略。 */
export interface ContextCheckpoint {
  version: 1
  messages: ChatMessage[]
  maxToolOutput: number
  /** 可选来源状态与旧版窗口检查点兼容。 */
  taskState?: TaskStateSnapshot
}

/** 检查持久化消息结构，避免损坏快照进入模型请求。 */
function validMessage(input: unknown): input is ChatMessage {
  if (!input || typeof input !== 'object') return false
  const message = input as Record<string, unknown>
  if (!['system', 'user', 'assistant', 'tool'].includes(String(message.role))) return false
  // 文本、空内容及图文列表均保留原有 wire 结构。
  const content = message.content
  if (content != null && typeof content !== 'string') {
    if (!Array.isArray(content) || !content.every(validPart)) return false
  }
  // 工具标识与参数必须可安全重放。
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || !message.tool_calls.every(validCall)) return false
  }
  return (message.tool_call_id === undefined || typeof message.tool_call_id === 'string')
    && (message.name === undefined || typeof message.name === 'string')
}

/** 校验模型支持的文本及图像内容块。 */
function validPart(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const part = input as Record<string, unknown>
  if (part.type === 'text') return typeof part.text === 'string'
  // 图像仅检查引用结构，不读取或解析图像数据。
  const image = part.image_url as Record<string, unknown> | undefined
  return part.type === 'image_url' && !!image && typeof image.url === 'string'
}

/** 校验工具调用及原始 JSON 参数字符串。 */
function validCall(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const call = input as Record<string, unknown>
  const fn = call.function as Record<string, unknown> | undefined
  return typeof call.id === 'string' && !!fn && typeof fn.name === 'string'
    && typeof fn.arguments === 'string'
    && (call.type === undefined || typeof call.type === 'string')
}

/** 未知版本或损坏快照交由原始事件回放处理。 */
export function validateCheckpoint(input: unknown): input is ContextCheckpoint {
  if (!input || typeof input !== 'object') return false
  const checkpoint = input as Record<string, unknown>
  return checkpoint.version === 1 && Array.isArray(checkpoint.messages)
    && checkpoint.messages.every(validMessage)
    && typeof checkpoint.maxToolOutput === 'number'
    && Number.isFinite(checkpoint.maxToolOutput) && checkpoint.maxToolOutput >= 0
    && (checkpoint.taskState === undefined || validateTaskState(checkpoint.taskState))
}

/** 克隆模型窗口，防止后续消息变更污染已发出的检查点。 */
export function createCheckpoint(messages: ChatMessage[], maxToolOutput: number, taskState?: TaskStateSnapshot): ContextCheckpoint {
  return { version: 1, messages: structuredClone(messages), maxToolOutput,
    ...(taskState ? { taskState: structuredClone(taskState) } : {}) }
}

/** 找到指定 Agent 最新的有效窗口替换事件。 */
export function latestCheckpoint(events: TaggedEvent[], agentId: string): {
  checkpoint: ContextCheckpoint; index: number
} | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const tagged = events[index]!
    const event = tagged.event as { type: string; checkpoint?: unknown }
    // 子 Agent 的检查点不能覆盖父 Agent 的窗口。
    if (tagged.agentId === agentId && event.type === 'context.checkpoint'
      && validateCheckpoint(event.checkpoint)) {
      return { checkpoint: event.checkpoint, index }
    }
  }
  return undefined
}

/** 将原始工具结果按同一策略加入窗口，已存在的检查点不经过此函数。 */
export function capMessage(message: ChatMessage, maxToolOutput: number): ChatMessage {
  const copy = structuredClone(message)
  if (copy.role === 'tool' && typeof copy.content === 'string') {
    copy.content = truncateToolOutput(copy.content, maxToolOutput).text
  }
  return copy
}

/** 使用检查点及后续事件重建模型窗口，兼容没有检查点的旧日志。 */
export function reconstructContext(
  events: TaggedEvent[], systemPrompt: string, agentId = 'main', maxToolOutput = 12_000,
): ChatMessage[] {
  const saved = latestCheckpoint(events, agentId)
  const initial = saved ? structuredClone(saved.checkpoint.messages) : []
  // 系统指令始终使用调用方当前配置，旧检查点只提供对话窗口。
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt },
    ...initial.filter((message) => message.role !== 'system')]
  const cap = saved?.checkpoint.maxToolOutput ?? maxToolOutput
  const replay = new ContextReplay(messages, cap)
  for (const tagged of events.slice(saved ? saved.index + 1 : 0)) {
    if (tagged.agentId === agentId) replay.accept(tagged.event)
  }
  replay.flush()
  return messages
}

/** 将工具调用与结果成组恢复，缺失结果明确标记为中断。 */
class ContextReplay {
  private calls: ToolCall[] = []
  private results = new Map<string, { name: string; output: string }>()
  private pendingText = ''
  private callText = ''

  constructor(private messages: ChatMessage[], private maxToolOutput: number) {}

  /** 在用户消息或回合边界前提交完整的工具调用组。 */
  flush(): void {
    if (!this.calls.length) return
    this.messages.push({ role: 'assistant', content: this.callText || null, tool_calls: this.calls })
    for (const call of this.calls) {
      const result = this.results.get(call.id)
      this.messages.push(capMessage({ role: 'tool', tool_call_id: call.id,
        name: result?.name ?? call.function.name,
        content: result?.output ?? 'aborted: no result recorded' }, this.maxToolOutput))
    }
    this.calls = []
    this.results.clear()
    this.callText = ''
  }

  /** 边界处结束工具组并丢弃未经完整模型输出确认的文本增量。 */
  private reset(): void {
    this.flush()
    this.pendingText = ''
  }

  /** 真正开始执行工具才确认该模型输出完整，将此前文字归入工具组。 */
  private recordCall(event: Extract<TaggedEvent['event'], { type: 'tool.call' }>): void {
    if (!this.calls.length) {
      this.callText = this.pendingText
      this.pendingText = ''
    }
    this.calls.push({ id: event.id, type: 'function',
      function: { name: event.name, arguments: JSON.stringify(event.args ?? {}) } })
  }

  /** 回放完整模型输出及工具事件，未完成的流式文字只暂存而不独立入窗。 */
  accept(event: TaggedEvent['event']): void {
    switch (event.type) {
      // 每次模型调用、会话结束或用户输入均建立明确的文本边界。
      case 'turn.start':
      case 'session.end':
        this.reset()
        break
      case 'text.delta':
        this.pendingText += event.text
        break
      // 用户图像必须与原始文字一同恢复。
      case 'user.message': {
        this.reset()
        const images = (event as typeof event & { images?: Array<{ mimeType: string; data: string }> }).images
        this.messages.push({ role: 'user', content: userContent(event.text, images) })
        break
      }
      // 原始调用保持 API 要求的 function 类型。
      case 'tool.call':
        this.recordCall(event)
        break
      // 孤儿结果不进入模型窗口；所有结果齐备后才提交该组。
      case 'tool.result':
        if (this.calls.some((call) => call.id === event.id)) {
          this.results.set(event.id, { name: event.name, output: event.output })
          if (this.calls.every((call) => this.results.has(call.id))) this.flush()
        }
        break
      // 仅正常完成的最终回答成为 assistant 历史。
      case 'turn.end':
        this.reset()
        if (event.stopReason === 'stop' && event.text) {
          this.messages.push({ role: 'assistant', content: event.text })
        }
        break
    }
  }
}
