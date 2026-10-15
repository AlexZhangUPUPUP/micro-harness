/**
 * Provider-backed compaction: turn the dropped middle of a conversation into a
 * short recap, keeping `context.ts` free of any model I/O.
 */

import type { ChatMessage } from './model.ts'
import type { Provider } from './provider.ts'
import { COMPACT_RECAP_PREFIX, type Summarizer } from './context.ts'

/** Hard ceiling per flattened message so one tool result cannot blow the prompt. */
const MAX_MESSAGE_CHARS = 2000

function clip(text: string | null | undefined, max: number): string {
  if (!text) return ''
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** Flatten one message into a single transcript block (tool calls included). */
function flattenMessage(m: ChatMessage): string {
  const parts: string[] = []
  if (m.role === 'tool') {
    parts.push(`[tool result for ${m.name ?? m.tool_call_id ?? 'unknown tool'}]`)
  } else {
    parts.push(`[${m.role}]`)
  }
  if (m.content) parts.push(clip(String(m.content), MAX_MESSAGE_CHARS))
  for (const tc of m.tool_calls ?? []) {
    parts.push(`tool_call ${tc.function.name}(${clip(tc.function.arguments, MAX_MESSAGE_CHARS)})`)
  }
  return parts.join('\n')
}

const SUMMARIZE_SYSTEM_PROMPT = [
  'Summarise the following earlier part of a conversation for use as a continuation.',
  'Keep file paths, decisions, constraints, and open questions verbatim.',
  'Drop pleasantries; be terse.',
].join(' ')

/**
 * Build a `Summarizer` that asks `provider` to fold the dropped messages into a
 * short recap, capped at `maxChars` (default 1200) and prefixed with
 * `COMPACT_RECAP_PREFIX`.
 */
export function makeSummarizer(
  provider: Provider,
  model: string,
  opts?: { maxChars?: number },
): Summarizer {
  const maxChars = opts?.maxChars ?? 1200
  return async (dropped: ChatMessage[]): Promise<string> => {
    const transcript = dropped.map(flattenMessage).join('\n\n')
    const res = await provider.chat({
      model,
      messages: [
        { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ],
      tools: [],
    })
    const summary = String(res.message.content ?? '').trim()
    const capped = summary.length <= maxChars ? summary : summary.slice(0, maxChars)
    return `${COMPACT_RECAP_PREFIX}\n${capped}`
  }
}
