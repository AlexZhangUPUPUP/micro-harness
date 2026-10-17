/**
 * Session persistence — JSONL is the source of truth (ARCHITECTURE.md §7).
 *
 * Everything the loop does is already an `AgentEvent`; a session is just that
 * stream appended to a file, so it can be replayed, searched, or read by other
 * tools without this project.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ChatMessage } from './model.ts'
import type { EventHub, TaggedEvent } from './events.ts'

export class SessionFile {
  readonly file: string

  constructor(file: string) {
    this.file = file
    mkdirSync(path.dirname(file), { recursive: true })
  }

  /** Bindable hub listener: `hub.on(session.append)`. */
  append = (e: TaggedEvent): void => {
    try {
      appendFileSync(this.file, JSON.stringify(e) + '\n')
    } catch {
      /* a failed write must never break the run */
    }
  }

  static read(file: string): TaggedEvent[] {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TaggedEvent)
  }
}

/** Create a session file and record every event of `hub` into it. */
export function attachSession(hub: EventHub, file: string): SessionFile {
  const session = new SessionFile(file)
  hub.on(session.append)
  return session
}

/** Replay a recorded session, yielding its events in order. */
export function replay(file: string, onEvent: (e: TaggedEvent) => void): number {
  const events = SessionFile.read(file)
  for (const e of events) {
    try {
      onEvent(e)
    } catch {
      /* a replay listener must not abort the replay */
    }
  }
  return events.length
}

/**
 * Rebuild the chat history of one agent from its event stream. Used to *resume*
 * a session: the JSONL is the source of truth, so a fresh `Harness` can pick up
 * exactly where the recorded one left off. Tool calls and their results are
 * re-paired; the final answer of each turn becomes an assistant message.
 */
export function reconstructMessages(
  events: TaggedEvent[],
  systemPrompt: string,
  agentId = 'main',
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt }]
  let calls: NonNullable<ChatMessage['tool_calls']> = []
  const results = new Map<string, { name: string; output: string }>()

  // Providers require *every* tool_call in an assistant message to be answered
  // immediately after it. Group the calls with their results, and synthesize an
  // answer for a call that never got one (the run was interrupted, or the
  // process died mid-tool) instead of emitting history the API will reject.
  const flush = (): void => {
    if (!calls.length) return
    messages.push({ role: 'assistant', content: null, tool_calls: calls })
    for (const call of calls) {
      const result = results.get(call.id)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: result?.name ?? call.function?.name ?? '',
        content: result?.output ?? 'aborted: no result recorded',
      })
    }
    calls = []
    results.clear()
  }

  for (const tagged of events) {
    if (tagged.agentId !== agentId) continue
    const event = tagged.event
    switch (event.type) {
      case 'user.message':
        flush()
        messages.push({ role: 'user', content: event.text })
        break
      case 'tool.call':
        calls.push({
          id: event.id,
          // The API rejects a replayed assistant message whose tool calls lack
          // `type`, so a reconstructed history must carry it too.
          type: 'function',
          function: { name: event.name, arguments: JSON.stringify(event.args ?? {}) },
        })
        break
      case 'tool.result':
        if (calls.some((c) => c.id === event.id)) {
          results.set(event.id, { name: event.name, output: event.output })
          if (calls.every((c) => results.has(c.id))) flush()
        }
        break
      case 'turn.end':
        flush()
        if (event.stopReason === 'stop' && event.text) messages.push({ role: 'assistant', content: event.text })
        break
      default:
        break
    }
  }
  flush()
  return messages
}
