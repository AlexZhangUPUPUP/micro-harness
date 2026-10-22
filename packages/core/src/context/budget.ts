import type { ChatMessage, ToolDef } from '../model.ts'
import { DEFAULT_TOOL_OUTPUT_CHARS, IMAGE_TOKENS, type Truncated } from './types.ts'

/** 按 UTF-8 字节统计中文与英文，除以四仍可能偏离实际 tokenizer。 */
function textTokens(text: string): number {
  return new TextEncoder().encode(text).byteLength / 4
}

/** 计算消息正文与调用参数成本，图片采用固定成本粗估。 */
export function estimateTokens(messages: ChatMessage[]): number {
  let tokens = 0
  // 单独处理多模态文本，避免数组转字符串后丢失有效信息。
  for (const message of messages) {
    if (typeof message.content === 'string') tokens += textTokens(message.content)
    else for (const part of message.content ?? []) {
      tokens += part.type === 'text' ? textTokens(part.text) : IMAGE_TOKENS
    }
    // 工具名称与参数同样进入提供方上下文。
    for (const call of message.tool_calls ?? []) {
      tokens += textTokens(call.function.name) + textTokens(call.function.arguments)
    }
  }
  return Math.ceil(tokens)
}

/** 估计完整请求成本，包括工具 schema 与角色、调用 ID 等封装开销。 */
export function estimateRequestTokens(messages: ChatMessage[], tools: ToolDef[] = []): number {
  const schemaTokens = tools.length ? textTokens(JSON.stringify(tools)) : 0
  const envelopeTokens = messages.reduce((total, message) => {
    // 对固定角色标记保留常数成本，再计算可变长度的调用标识。
    return total + 4 + textTokens(message.name ?? '') + textTokens(message.tool_call_id ?? '')
      + (message.tool_calls ?? []).reduce((sum, call) => sum + 4 + textTokens(call.id), 0)
  }, 3)
  return Math.ceil(estimateTokens(messages) + schemaTokens + envelopeTokens)
}

/** 保留工具输出头尾，明确标记省略范围，零或负上限沿用禁用截断语义。 */
export function truncateToolOutput(text: string, max = DEFAULT_TOOL_OUTPUT_CHARS): Truncated {
  if (max <= 0 || text.length <= max) return { text, elided: 0 }
  const head = Math.floor(max * 0.6)
  const tail = Math.max(0, max - head)
  const elided = text.length - head - tail
  const marker = `\n\n… [${elided} of ${text.length} characters elided — call the tool again with narrower arguments to read the rest] …\n\n`
  return { text: text.slice(0, head) + marker + (tail ? text.slice(text.length - tail) : ''), elided }
}
