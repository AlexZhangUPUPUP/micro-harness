/**
 * Context windowing and compaction — the third leg of a harness.
 *
 * Two policies matter here, and they are related:
 *
 *  1. **Never rewrite the past.** A tool output is capped *when it is appended*, never
 *     later, so the message prefix stays byte-stable across turns. Providers cache on
 *     the prefix, so rewriting history (for example trimming from the front) throws
 *     the cache away on every single turn.
 *  2. **When the window does fill, drop the middle — not the front.** The first user
 *     turn usually carries the constraints ("don't touch the public API"), and the
 *     system prompt plus that head is exactly the part of the prefix a provider can
 *     keep cached.
 *
 * A "unit" is a user message plus everything the assistant and its tools produced for
 * it, so a tool message is never orphaned from the tool call that produced it.
 */

import type { ChatMessage } from './model.ts'

/**
 * Fixed per-image token cost used by `estimateTokens`. This is a rough estimate
 * (vision models charge anywhere from a few hundred to ~1k tokens per image),
 * not a real tokenizer.
 */
export const IMAGE_TOKENS = 800

/** Cheap, model-agnostic estimate: ~4 characters per token. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  let images = 0
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length
    } else if (m.content) {
      // A multimodal part list: count the text parts, plus a fixed per-image cost.
      for (const part of m.content) {
        if (part.type === 'text') chars += part.text.length
        else if (part.type === 'image_url') images += 1
      }
    }
    if (m.tool_calls) {
      for (const t of m.tool_calls) {
        chars += (t.function?.name?.length || 0) + (t.function?.arguments?.length || 0)
      }
    }
  }
  return Math.ceil(chars / 4) + images * IMAGE_TOKENS
}

/** Cap applied to a tool result before it becomes a message (~3k tokens by default). */
export const DEFAULT_TOOL_OUTPUT_CHARS = 12_000

export interface Truncated {
  text: string
  /** Characters removed; 0 means the text was already within the cap. */
  elided: number
}

/**
 * Keep the head and the tail of an oversized tool result and say what was cut, so the
 * model can ask for the rest instead of silently missing it.
 */
export function truncateToolOutput(text: string, max: number = DEFAULT_TOOL_OUTPUT_CHARS): Truncated {
  if (max <= 0 || text.length <= max) return { text, elided: 0 }
  const head = Math.floor(max * 0.6)
  const tail = Math.max(0, max - head)
  const elided = text.length - head - tail
  const marker = `\n\n… [${elided} of ${text.length} characters elided — call the tool again with narrower arguments to read the rest] …\n\n`
  return { text: text.slice(0, head) + marker + (tail ? text.slice(text.length - tail) : ''), elided }
}

/** A model-backed compaction strategy: turn the dropped middle into a short recap. */
export type Summarizer = (dropped: ChatMessage[]) => Promise<string>

/** Prefix every recap message with this so callers and models can tell it apart. */
export const COMPACT_RECAP_PREFIX = '[earlier context, compacted]'

export interface CompactOptions {
  maxTokens: number
  /**
   * Keep the first user unit in addition to the newest ones. Default true: it
   * preserves early constraints and keeps a cacheable prefix.
   */
  keepHead?: boolean
}

export interface TrimResult {
  messages: ChatMessage[]
  /** Messages dropped from the middle of the conversation. */
  dropped: number
  /** Estimated tokens after compaction. */
  tokens: number
  strategy: 'none' | 'keep-head+tail' | 'tail' | 'steps' | 'keep-head+steps' | 'summarize'
  /** How many messages were folded into a recap message (summarize strategy only). */
  summarized?: number
}

/** Group messages into units: each user message starts a new one. */
function groupUnits(messages: ChatMessage[]): ChatMessage[][] {
  const units: ChatMessage[][] = []
  for (const m of messages) {
    if (m.role === 'user' || units.length === 0) units.push([m])
    else units[units.length - 1]!.push(m)
  }
  return units
}

interface CompactPlan {
  system: ChatMessage[]
  head: ChatMessage[]
  tail: ChatMessage[]
  /** Messages removed from the middle (the part a summarizer would fold). */
  dropped: ChatMessage[]
  strategy: 'none' | 'keep-head+tail' | 'tail' | 'steps' | 'keep-head+steps'
}

/** Compute the deterministic drop-middle plan without mutating anything. */
/**
 * A step is one assistant message plus the tool results it produced. Used to trim
 * *inside* a single long turn — the shape a coding agent actually has (one user message
 * and dozens of tool calls), where there are no older turns to drop.
 */
function groupSteps(unit: ChatMessage[]): ChatMessage[][] {
  const steps: ChatMessage[][] = []
  for (const m of unit) {
    if (m.role === 'assistant' || steps.length === 0) steps.push([m])
    else steps[steps.length - 1]!.push(m)
  }
  return steps
}

function compactPlan(messages: ChatMessage[], options: CompactOptions): CompactPlan {
  const { maxTokens } = options
  const system = messages.filter((m) => m.role === 'system')
  const rest = messages.filter((m) => m.role !== 'system')
  const units = groupUnits(rest)

  // Keep the head only when there is something to separate it from the tail.
  const headCount = (options.keepHead ?? true) && units.length > 1 ? 1 : 0
  const head = units.slice(0, headCount).flat()
  const tailUnits = units.slice(headCount)

  const kept: ChatMessage[][] = []
  for (let i = tailUnits.length - 1; i >= 0; i--) {
    kept.unshift(tailUnits[i]!)
    // Always keep at least the newest unit, even if it alone blows the budget.
    if (estimateTokens([...system, ...head, ...kept.flat()]) > maxTokens && kept.length > 1) {
      kept.shift()
      break
    }
  }

  let tail = kept.flat()
  let dropped = tailUnits.slice(0, tailUnits.length - kept.length).flat()
  let strategy: TrimResult['strategy'] = headCount ? 'keep-head+tail' : 'tail'

  // A single long turn cannot be trimmed by dropping whole units, so fall back to
  // dropping the oldest *steps* inside the newest unit. We never drop the user message
  // that states the task, never drop the newest step, and never separate a tool result
  // from the tool call that produced it.
  if (tail.length > 0 && estimateTokens([...system, ...head, ...tail]) > maxTokens) {
    const lastUnit = units[units.length - 1] ?? []
    const steps = groupSteps(lastUnit)
    if (steps.length > 2) {
      const lead = steps[0]!
      const body: ChatMessage[][] = steps.slice(1)
      const leadIndex = tail.length - lastUnit.length
      let keepFrom = 0
      while (keepFrom < body.length - 1 && estimateTokens([...system, ...head, ...tail.slice(0, leadIndex), ...lead, ...body.slice(keepFrom).flat()]) > maxTokens) {
        keepFrom++
      }
      if (keepFrom > 0) {
        const droppedSteps = body.slice(0, keepFrom).flat()
        tail = [...tail.slice(0, leadIndex), ...lead, ...body.slice(keepFrom).flat()]
        dropped = [...dropped, ...droppedSteps]
        strategy = headCount ? 'keep-head+steps' : 'steps'
      }
    }
  }

  return { system, head, tail, dropped, strategy }
}

/** Trim a conversation to a token budget, dropping the middle when possible. */
export function compactMessages(messages: ChatMessage[], options: CompactOptions): TrimResult {
  const { maxTokens } = options
  const estimated = estimateTokens(messages)
  if (estimated <= maxTokens) return { messages, dropped: 0, tokens: estimated, strategy: 'none' }

  const plan = compactPlan(messages, options)
  const flat = [...plan.head, ...plan.tail]
  const compacted = [...plan.system, ...flat]
  return {
    messages: compacted,
    dropped: plan.dropped.length,
    tokens: estimateTokens(compacted),
    strategy: plan.strategy,
  }
}

/** Make sure a recap carries the standard prefix without doubling it. */
function ensureRecapPrefix(text: string): string {
  return text.startsWith(COMPACT_RECAP_PREFIX) ? text : `${COMPACT_RECAP_PREFIX}\n${text}`
}

/**
 * Async strategy seam. Computes the deterministic drop-middle plan; when a
 * `summarizer` is provided and something would be dropped, fold the dropped
 * messages into a single recap message instead. Falls back to the deterministic
 * result if the summarizer throws.
 */
export async function compactMessagesAsync(
  messages: ChatMessage[],
  options: CompactOptions & { summarizer?: Summarizer },
): Promise<TrimResult> {
  const base = compactMessages(messages, options)
  const { summarizer } = options

  // Nothing to drop, or no model to summarise with: identical to the sync path.
  if (!summarizer || base.dropped === 0) return base

  const plan = compactPlan(messages, options)
  if (plan.dropped.length === 0) return base

  let recap: string
  try {
    recap = await summarizer(plan.dropped)
  } catch {
    return base
  }

  const recapMessage: ChatMessage = { role: 'user', content: ensureRecapPrefix(recap) }
  const compacted = [...plan.system, ...plan.head, recapMessage, ...plan.tail]
  return {
    messages: compacted,
    // The recap is one kept message, so it does not count as dropped.
    dropped: plan.dropped.length - 1,
    tokens: estimateTokens(compacted),
    strategy: 'summarize',
    summarized: plan.dropped.length,
  }
}

/** Backwards-compatible entry point: trim with the default (head-preserving) policy. */
export function trimMessages(messages: ChatMessage[], maxTokens: number): TrimResult {
  return compactMessages(messages, { maxTokens })
}
