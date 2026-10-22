import type { ChatMessage } from '../model.ts'

/** 为缺失的工具结果补充明确失败信息，避免请求包含悬空调用。 */
function missingResult(id: string, name: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, name,
    content: '[tool result unavailable: execution was interrupted before its result was recorded]' }
}

/** 整理一组工具结果，移除孤儿和重复项，并补齐缺失的调用输出。 */
function pairResults(assistant: ChatMessage, results: ChatMessage[]): ChatMessage[] {
  const calls = assistant.tool_calls ?? []
  const expected = new Map(calls.map((call) => [call.id, call]))
  const matched = new Set<string>()
  const paired: ChatMessage[] = []
  // 有效结果保留原对象与顺序，只有缺失或无效配对才改变消息序列。
  for (const result of results) {
    const id = result.tool_call_id ?? ''
    if (!expected.has(id) || matched.has(id)) continue
    paired.push(result)
    matched.add(id)
  }
  // 所有调用必须具有一条结果，即使实际执行因进程中断而没有完成。
  for (const call of calls) {
    if (!matched.has(call.id)) {
      paired.push(missingResult(call.id, call.function.name))
      matched.add(call.id)
    }
  }
  return paired
}

/** 纯函数修复工具调用配对，不修改有效消息对象或输入数组。 */
export function normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
  const normalized: ChatMessage[] = []
  // 工具结果只能紧跟产生它的助手调用，跨用户边界的结果视为孤儿。
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.role === 'tool') continue
    normalized.push(message)
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue
    const results: ChatMessage[] = []
    while (messages[index + 1]?.role === 'tool') results.push(messages[++index]!)
    normalized.push(...pairResults(message, results))
  }
  return normalized
}
