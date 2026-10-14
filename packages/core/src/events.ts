/**
 * The agent event contract — ARCHITECTURE.md §3.5.
 *
 * Every observable thing the loop does is one of these events. The session JSONL,
 * the server's SSE stream, the CLI, the GUI trace and the replay scrubber are all
 * just consumers of this one stream, tagged with the agent that produced it so a
 * multi-agent run can be reconstructed as a tree.
 */

export type AgentEvent =
  | { type: 'session.start'; model: string; cwd: string }
  | { type: 'turn.start'; turn: number }
  | { type: 'text.delta'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'tool.call'; id: string; name: string; args: unknown }
  | { type: 'tool.result'; id: string; name: string; ok: boolean; output: string; ms: number }
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cost?: number }
  | { type: 'context.trim'; dropped: number; tokens: number; strategy: string }
  | { type: 'permission.request'; id: string; tool: string; args: unknown }
  | { type: 'permission.result'; id: string; decision: 'allow' | 'deny' }
  | { type: 'turn.end'; stopReason: string; text: string }
  | { type: 'session.end'; reason: string }
  | { type: 'error'; message: string; fatal?: boolean }

/** An event plus the identity/monotonic coordinates needed to rebuild a tree. */
export interface TaggedEvent {
  agentId: string
  parentId: string | null
  seq: number
  t: number
  event: AgentEvent
}

export type EventListener = (e: TaggedEvent) => void

/** Fan-out for tagged events. One hub per run; every agent logs into it. */
export class EventHub {
  readonly #listeners = new Set<EventListener>()

  on(fn: EventListener): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  forward(e: TaggedEvent): void {
    for (const l of [...this.#listeners]) {
      try {
        l(e)
      } catch {
        /* a listener must never break the run */
      }
    }
  }

  /** Collect every event into an array (handy for tests, replay and traces). */
  collect(): TaggedEvent[] {
    const out: TaggedEvent[] = []
    this.on((e) => out.push(e))
    return out
  }
}

/** A per-agent emitter: tags events, assigns seq/time, forwards to the hub. */
export class AgentLog {
  #seq = 0
  constructor(
    readonly hub: EventHub,
    readonly agentId: string,
    readonly parentId: string | null = null,
  ) {}

  emit(event: AgentEvent): TaggedEvent {
    const tagged: TaggedEvent = {
      agentId: this.agentId,
      parentId: this.parentId,
      seq: ++this.#seq,
      t: Date.now(),
      event,
    }
    this.hub.forward(tagged)
    return tagged
  }

  /** A child agent's log — same hub, linked by parentId. */
  child(agentId: string): AgentLog {
    return new AgentLog(this.hub, agentId, this.agentId)
  }
}
