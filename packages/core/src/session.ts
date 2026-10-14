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
  let pendingCalls: NonNullable<ChatMessage['tool_calls']> = []

  const flushCalls = (): void => {
    if (!pendingCalls.length) return
    messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls })
    pendingCalls = []
  }

  for (const tagged of events) {
    if (tagged.agentId !== agentId) continue
    const event = tagged.event
    switch (event.type) {
      case 'user.message':
        flushCalls()
        messages.push({ role: 'user', content: event.text })
        break
      case 'tool.call':
        pendingCalls.push({
          id: event.id,
          function: { name: event.name, arguments: JSON.stringify(event.args ?? {}) },
        })
        break
      case 'tool.result':
        flushCalls()
        messages.push({ role: 'tool', tool_call_id: event.id, name: event.name, content: event.output })
        break
      case 'turn.end':
        flushCalls()
        if (event.stopReason === 'stop' && event.text) messages.push({ role: 'assistant', content: event.text })
        break
      default:
        break
    }
  }
  flushCalls()
  return messages
}
