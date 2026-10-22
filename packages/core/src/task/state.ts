import type { ChatMessage } from '../model.ts'

/** 来源证据保留原文和时序，不从助手的完成声明推断执行成功。 */
export interface TaskEvidence {
  order: number
  source: 'user' | 'tool'
  text: string
  tool?: string
  callId?: string
  truncated: boolean
}

/** 任务状态独立于可丢弃的模型窗口，当前版本仅保存有界来源证据。 */
export interface TaskStateSnapshot { version: 1; nextOrder: number; omitted: number; entries: TaskEvidence[] }

/** 投影只作为带来源的历史数据，不能提升为系统规则。 */
export const TASK_STATE_NAME = 'harness_task_evidence'
const MAX_ENTRIES = 64
const MAX_ENTRY_CHARS = 2048
const MAX_SOURCE_ENTRIES = 32

/** 提取文本内容；图像仍由原始日志和模型窗口保存，不复制 base64。 */
function textOf(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
}

/** 历史投影有专用名字，正常用户正文即使含相同前缀也不会被误删。 */
export function isTaskProjection(message: ChatMessage): boolean {
  return message.role === 'assistant' && message.name === TASK_STATE_NAME
}

/** 严格检查持久化边界，避免损坏或超大状态进入恢复链路。 */
export function validateTaskState(input: unknown): input is TaskStateSnapshot {
  if (!input || typeof input !== 'object') return false
  const state = input as TaskStateSnapshot
  if (state.version !== 1 || !Number.isSafeInteger(state.nextOrder) || state.nextOrder < 1
    || !Number.isSafeInteger(state.omitted) || state.omitted < 0
    || !Array.isArray(state.entries) || state.entries.length > MAX_ENTRIES) return false
  // 恢复入口同样遵守分来源配额，不能通过外部快照绕过正常写入限制。
  if (state.entries.filter((entry) => entry?.source === 'user').length > MAX_SOURCE_ENTRIES
    || state.entries.filter((entry) => entry?.source === 'tool').length > MAX_SOURCE_ENTRIES) return false
  let previous = 0
  // 时序严格递增，恢复后新增证据不能覆盖已有序号。
  return state.entries.every((entry) => {
    if (!entry || !Number.isSafeInteger(entry.order) || entry.order <= previous || entry.order >= state.nextOrder
      || !['user', 'tool'].includes(entry.source) || typeof entry.text !== 'string'
      || entry.text.length > MAX_ENTRY_CHARS || typeof entry.truncated !== 'boolean'
      || (entry.tool !== undefined && (typeof entry.tool !== 'string' || entry.tool.length > 128))
      || (entry.callId !== undefined && (typeof entry.callId !== 'string' || entry.callId.length > 256))) return false
    previous = entry.order
    return true
  })
}

/** 管理来源证据；语义冲突由模型依据用户纠正与时序处理，不猜测键值协议。 */
export class TaskState {
  private state: TaskStateSnapshot = { version: 1, nextOrder: 1, omitted: 0, entries: [] }

  /** 原始用户输入和工具观察才可进入状态，摘要与助手文本均排除。 */
  observe(message: ChatMessage, deduplicate = false): void {
    if ((message.role !== 'user' && message.role !== 'tool') || isTaskProjection(message)) return
    const raw = textOf(message).trim()
    if (!raw) return
    const marker = '\n[... content omitted ...]\n'
    const half = Math.floor((MAX_ENTRY_CHARS - marker.length) / 2)
    const text = raw.length <= MAX_ENTRY_CHARS ? raw
      : raw.slice(0, half) + marker + raw.slice(-half)
    const entry: TaskEvidence = { order: this.state.nextOrder, source: message.role, text,
      truncated: raw.length > MAX_ENTRY_CHARS,
      ...(message.role === 'tool' ? { tool: message.name?.slice(0, 128), callId: message.tool_call_id?.slice(0, 256) } : {}) }
    // 快照中的重复旧消息不应倒转纠正顺序，也不应重复占用容量。
    if ((deduplicate || entry.source === 'tool') && this.state.entries.some((old) => old.source === entry.source
      && old.text === entry.text && old.callId === entry.callId && old.tool === entry.tool)) return
    this.state.nextOrder++
    this.state.entries.push(entry)
    this.evict(entry.source)
  }

  /** 用户与工具独立配额，工具优先淘汰长输出，避免噪声冲掉短观察。 */
  private evict(source: TaskEvidence['source']): void {
    const entries = this.state.entries.filter((entry) => entry.source === source)
    if (entries.length <= MAX_SOURCE_ENTRIES) return
    // 用户保留首个目标和最近纠正；工具同长度时先淘汰旧记录。
    const removed = source === 'user' ? entries[1]!
      : [...entries].sort((a, b) => b.text.length - a.text.length || a.order - b.order)[0]!
    this.state.entries = this.state.entries.filter((entry) => entry !== removed)
    this.state.omitted++
  }

  /** 返回独立快照，调用方不能修改运行中的来源证据。 */
  snapshot(): TaskStateSnapshot { return structuredClone(this.state) }

  /** 仅安装经过完整结构校验的持久化状态。 */
  restore(snapshot: TaskStateSnapshot): void {
    if (!validateTaskState(snapshot)) throw new Error('Invalid task state snapshot')
    this.state = structuredClone(snapshot)
  }

  /** 有限预算优先用户文字与紧凑观察，最终仍按来源时间顺序展示。 */
  project(maxChars: number): string {
    const candidates = [...this.state.entries].sort((a, b) => {
      if (a.source !== b.source) return a.source === 'user' ? -1 : 1
      if (a.source === 'user') return b.order - a.order
      return a.text.length - b.text.length || b.order - a.order
    })
    const selected: TaskEvidence[] = []
    const render = () => JSON.stringify({ omitted: this.state.omitted + this.state.entries.length - selected.length,
      entries: [...selected].sort((a, b) => a.order - b.order) })
    // 整条选择避免投影把关键路径或 nonce 从中间劈开。
    for (const entry of candidates) {
      selected.push(entry)
      if (render().length > maxChars) selected.pop()
    }
    return selected.length ? render() : ''
  }
}
