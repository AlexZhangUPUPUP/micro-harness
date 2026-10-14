/**
 * Context windowing — the third leg of a harness.
 *
 * Models have a finite context window, so a long run must be trimmed. This is a
 * deliberately simple policy: keep the system prompt and the newest "units",
 * where a unit is a user message plus everything the assistant/tools produced
 * for it (a tool message must never be orphaned from its tool call).
 */

import type { ChatMessage } from './model.ts'

/** Cheap, model-agnostic estimate: ~4 characters per token. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    if (m.content) chars += String(m.content).length
    if (m.tool_calls) {
      for (const t of m.tool_calls) {
        chars += (t.function?.name?.length || 0) + (t.function?.arguments?.length || 0)
      }
    }
  }
  return Math.ceil(chars / 4)
}

export interface TrimResult {
  messages: ChatMessage[]
  dropped: number
}

export function trimMessages(messages: ChatMessage[], maxTokens: number): TrimResult {
  if (estimateTokens(messages) <= maxTokens) return { messages, dropped: 0 }

  const system = messages.filter((m) => m.role === 'system')
  const rest = messages.filter((m) => m.role !== 'system')

  // Group into units: a new unit starts at every user message.
  const units: ChatMessage[][] = []
  for (const m of rest) {
    if (m.role === 'user' || units.length === 0) units.push([m])
    else units[units.length - 1]!.push(m)
  }

  // Keep whole units from the end until the budget would be exceeded (always
  // keep at least the last unit).
  const kept: ChatMessage[][] = []
  for (let i = units.length - 1; i >= 0; i--) {
    kept.unshift(units[i]!)
    if (estimateTokens([...system, ...kept.flat()]) > maxTokens && kept.length > 1) {
      kept.shift()
      break
    }
  }

  const flat = kept.flat()
  return { messages: [...system, ...flat], dropped: rest.length - flat.length }
}
