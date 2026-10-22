import type { ChatMessage } from '../model.ts'

/** 摘要记录独立编码，避免截断 JSON 后破坏角色和调用标识。 */
interface Entry { index: number; message: ChatMessage; text: string; encoded: string }

/** 多模态历史只抽取文本和图片占位，不复制图片数据。 */
function contentText(message: ChatMessage): string {
  if (typeof message.content === 'string') return message.content
  return (message.content ?? []).map((part) => part.type === 'text' ? part.text : '[image omitted]').join('\n')
}

/** 保留完整结构；缩短正文和参数时显式注明省略。 */
function encode(message: ChatMessage, text: string, limit = Infinity): string {
  const shorten = (value: string): string => {
    // 大记录同时保留开头与结尾，省略标记属于记录内容而非破损 JSON。
    if (value.length <= limit) return value
    const head = Math.ceil(limit / 2)
    return value.slice(0, head) + '[... content omitted ...]' + (limit > head ? value.slice(-(limit - head)) : '')
  }
  return JSON.stringify({ role: message.role, label: message.role === 'tool' ? 'tool result' : message.role,
    text: shorten(text), tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls?.map((call) => ({ id: call.id, name: call.function.name,
      arguments: shorten(call.function.arguments) })) })
}

/** 统一按原始时间顺序渲染，明确指出未选中的历史记录。 */
function render(entries: Entry[], selected: Map<number, string>): string {
  const records: string[] = []
  let previous = -1
  for (const entry of entries) {
    const record = selected.get(entry.index)
    if (record === undefined) continue
    // 间隔标记同样计入请求预算，不让选择过程隐式超额。
    if (entry.index > previous + 1) records.push(JSON.stringify({ omitted_records: entry.index - previous - 1 }))
    records.push(record)
    previous = entry.index
  }
  if (previous < entries.length - 1) records.push(JSON.stringify({ omitted_records: entries.length - previous - 1 }))
  return records.join('\n')
}

/** 尝试收纳完整记录；无法容纳时，仅为高优先级记录寻找有界摘要片段。 */
function include(entry: Entry, entries: Entry[], selected: Map<number, string>, fits: (text: string) => boolean, clip: boolean): void {
  selected.set(entry.index, entry.encoded)
  if (fits(render(entries, selected))) return
  selected.delete(entry.index)
  if (!clip) return
  let low = 0
  let high = Math.max(entry.text.length, ...(entry.message.tool_calls ?? []).map((call) => call.function.arguments.length))
  // 二分只缩短字段内容，角色、调用 ID 和 JSON 边界始终完整。
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    selected.set(entry.index, encode(entry.message, entry.text, middle))
    if (fits(render(entries, selected))) low = middle
    else high = middle - 1
  }
  selected.set(entry.index, encode(entry.message, entry.text, low))
  if (!low || !fits(render(entries, selected))) selected.delete(entry.index)
}

/** 优先用户约束和纠正、短且不同的观察，最后补充其他历史，所有记录保持时间顺序。 */
export function selectSummaryTranscript(messages: ChatMessage[], fits: (text: string) => boolean): string {
  const entries = messages.map((message, index) => {
    const text = contentText(message)
    return { index, message, text, encoded: encode(message, text) }
  })
  const selected = new Map(entries.map((entry) => [entry.index, entry.encoded]))
  if (fits(render(entries, selected))) return render(entries, selected)
  selected.clear()
  // 用户短消息先完整保留，避免单条长请求挤掉中途纠正；长消息随后有界收纳。
  const users = entries.filter((entry) => entry.message.role === 'user')
    .sort((left, right) => left.encoded.length - right.encoded.length || right.index - left.index)
  for (const entry of users) include(entry, entries, selected, fits, false)
  for (const entry of users) if (!selected.has(entry.index)) include(entry, entries, selected, fits, true)
  const seen = new Set<string>()
  // 重复工具日志只保留最新一份，让有限额度覆盖更多不同观察。
  const observations = entries.filter((entry) => entry.message.role !== 'user').reverse().filter((entry) => {
    const key = JSON.stringify({ role: entry.message.role, text: entry.text, calls: entry.message.tool_calls })
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((left, right) => left.encoded.length - right.encoded.length || right.index - left.index)
  for (const entry of observations) include(entry, entries, selected, fits, false)
  // 剩余额度只容纳一条较新的大记录片段，避免重复日志抢占短观察。
  const remaining = observations.filter((entry) => !selected.has(entry.index)).sort((left, right) => right.index - left.index)
  for (const entry of remaining) include(entry, entries, selected, fits, true)
  const transcript = render(entries, selected)
  return fits(transcript) ? transcript : ''
}
