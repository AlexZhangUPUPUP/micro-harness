import type { ChatMessage } from '../../../packages/core/src/model.ts'
import type { Provider, ChatRequest } from '../../../packages/core/src/provider.ts'
import { estimateRequestTokens, estimateTokens } from '../../../packages/core/src/context/index.ts'

/** 将模型实际收到的文本合并；图片内容不参与 mock 的语义推断。 */
function visibleText(messages: ChatMessage[]): string {
  return messages.map((message) => typeof message.content === 'string' ? message.content
    : (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')).join('\n')
}

/** 仅识别当前请求可见的状态记录，后出现的纠正覆盖旧值。 */
export function visibleFacts(messages: ChatMessage[]): Record<string, string> {
  const facts: Record<string, string> = {}
  for (const match of visibleText(messages).matchAll(/STATE\s+([a-z_]+)=([A-Za-z0-9_./:-]+)/g)) facts[match[1]!] = match[2]!
  return facts
}

/** 区分内部摘要请求与普通判题请求，不读取任何场景或期望对象。 */
export function isSummaryRequest(request: ChatRequest): boolean {
  return request.tools.length === 0 && String(request.messages[0]?.content).startsWith('Summarize conversation')
}

/** 依请求中的字段列表作答，缺失依据必须明确返回 unknown。 */
function answer(request: ChatRequest): string {
  const user = [...request.messages].reverse().find((message) => message.role === 'user')
  const match = visibleText(user ? [user] : []).match(/FIELDS:\s*(\[[^\n]+\])/)
  if (!match) throw new Error('Probe request is missing its field list')
  const fields = JSON.parse(match[1]!) as string[]
  const facts = visibleFacts(request.messages)
  return JSON.stringify(Object.fromEntries(fields.map((field) => [field, facts[field] ?? 'unknown'])))
}

/** 离线只验证请求可见性和真实 Harness 链路，不能证明模型摘要质量。 */
export function requestVisibleProvider(): Provider {
  return { name: 'request-visible-mock', async chat(request) {
    const content = isSummaryRequest(request)
      ? 'Task handoff\n' + Object.entries(visibleFacts(request.messages)).map(([key, value]) => `STATE ${key}=${value}`).join('\n')
      : answer(request)
    return { message: { role: 'assistant', content }, usage: {
      prompt_tokens: estimateRequestTokens(request.messages, request.tools),
      completion_tokens: estimateTokens([{ role: 'assistant', content }]),
    } }
  } }
}
