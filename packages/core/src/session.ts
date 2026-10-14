/**
 * Session persistence — JSONL is the source of truth (ARCHITECTURE.md §7).
 *
 * Everything the loop does is already an `AgentEvent`; a session is just that
 * stream appended to a file, so it can be replayed, searched, or read by other
 * tools without this project.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
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
