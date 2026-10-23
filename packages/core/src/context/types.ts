import type { ChatMessage } from '../model.ts'

/** 图片采用固定成本粗估，实际计费依提供方与图片尺寸而异。 */
export const IMAGE_TOKENS = 800
/** 工具结果默认保留约三千个英文 token 的字符量。 */
export const DEFAULT_TOOL_OUTPUT_CHARS = 12_000
/** 摘要前缀用于区分历史回顾与真实用户指令。 */
export const COMPACT_RECAP_PREFIX = '[earlier context, compacted]'

/** 工具输出截断结果，elided 为被省略的字符数。 */
export interface Truncated { text: string; elided: number }
/** 摘要调用共享父取消信号，并接收本次允许使用的输出预算。 */
export interface SummarizeOptions { signal?: AbortSignal; maxTokens?: number }
/** 将待移除消息转为有界的交接摘要。 */
export type Summarizer = (dropped: ChatMessage[], options?: SummarizeOptions) => Promise<string>
/** 压缩参数，默认保留首条用户约束。 */
export interface CompactOptions { maxTokens: number; keepHead?: boolean; signal?: AbortSignal }
/** 压缩结果；changed 独立于消息净减少数，overflow 表示不可裁内容仍超限。 */
export interface TrimResult {
  messages: ChatMessage[]
  dropped: number
  tokens: number
  strategy: 'none' | 'keep-head+tail' | 'tail' | 'steps' | 'keep-head+steps' | 'summarize'
  summarized?: number
  changed: boolean
  overflow?: boolean
  /** 摘要不可用时是否退回确定性裁剪。 */
  fallback?: boolean
}
