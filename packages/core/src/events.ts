/**
 * The agent event contract — ARCHITECTURE.md §3.5.
 *
 * Every observable thing the loop does is one of these events. The session JSONL,
 * the server's SSE stream, the CLI, the GUI trace and the replay scrubber are all
 * just consumers of this one stream, tagged with the agent that produced it so a
 * multi-agent run can be reconstructed as a tree.
 */

export type AgentEvent =
  | { type: 'session.start'; model: string; cwd: string; parentId?: string | null }
  | { type: 'user.message'; text: string }
  | { type: 'turn.start'; turn: number }
  /**
   * The exact payload handed to the model for one turn. This duplicates content
   * that is already on the stream (that is the point): it is the only way to see
   * what the model actually received *after* trimming. It is deliberately not
   * indexed for search — see `eventText`.
   */
  | { type: 'model.request'; model: string; system: string; tools: string[]; messages: unknown[]; tokens: number }
  | { type: 'text.delta'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'tool.call'; id: string; name: string; args: unknown; sandbox?: string }
  | { type: 'tool.result'; id: string; name: string; ok: boolean; output: string; ms: number; elided?: number }
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cost?: number; model?: string; reasoning?: number; durationMs?: number }
  | { type: 'context.trim'; dropped: number; tokens: number; strategy: string }
  | { type: 'agent.worktree'; path: string; branch: string; base: string }
  | { type: 'permission.request'; id: string; tool: string; args: unknown; sandbox?: string; preview?: { before?: string } }
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

/** One node of the reconstructed agent tree (see `buildAgentTree`). */
export interface AgentNode {
  agentId: string
  parentId: string | null
  input: number
  output: number
  cost: number
  status: 'running' | 'done' | 'error'
  text?: string
  children: AgentNode[]
}

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

/** Extract the human/LLM-readable text of an event, for full-text indexing. */
export function eventText(event: AgentEvent): string | null {
  switch (event.type) {
    case 'user.message':
      return event.text
    case 'text.delta':
    case 'thinking.delta':
      return event.text
    case 'turn.end':
      return event.text
    case 'tool.call':
      return `${event.name} ${JSON.stringify(event.args)}`
    case 'tool.result':
      return event.output
    case 'error':
      return event.message
    default:
      return null
  }
}

/**
 * Rebuild the agent tree from a tagged event stream. Every agent is identified by
 * `agentId`/`parentId`; `usage` events accumulate cost, `turn.end`/`error` set the
 * status. Returns the roots (normally just the main agent).
 */
export function buildAgentTree(events: TaggedEvent[]): AgentNode[] {
  const nodes = new Map<string, AgentNode>()
  const ensure = (agentId: string, parentId: string | null): AgentNode => {
    let node = nodes.get(agentId)
    if (!node) {
      node = { agentId, parentId: parentId ?? null, input: 0, output: 0, cost: 0, status: 'running', children: [] }
      nodes.set(agentId, node)
    }
    return node
  }

  for (const e of events) {
    const node = ensure(e.agentId, e.parentId)
    const ev = e.event
    if (ev.type === 'usage') {
      node.input += ev.input
      node.output += ev.output
      node.cost += ev.cost ?? 0
    } else if (ev.type === 'turn.end') {
      node.status = 'done'
      node.text = ev.text
    } else if (ev.type === 'error') {
      node.status = 'error'
      node.text = ev.message
    }
  }

  const roots: AgentNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  for (const node of nodes.values()) node.children.sort((a, b) => a.agentId.localeCompare(b.agentId))
  return roots
}

/** Human-readable rendering of an agent tree, with per-agent tokens and cost. */
export function formatAgentTree(roots: AgentNode[]): string {
  const lines: string[] = []
  let total = 0
  const render = (node: AgentNode, indent: string, last: boolean): void => {
    total += node.cost
    const tokens = node.input + node.output
    const cost = node.cost ? ` · $${node.cost.toFixed(6)}` : ''
    const label = node.agentId === 'main' ? 'main' : node.agentId.split('/').pop()
    lines.push(`${indent}${last ? '└─' : '├─'} ${label} · ${node.status} · ${tokens}tok${cost}`)
    node.children.forEach((c, i) => render(c, indent + (last ? '   ' : '│  '), i === node.children.length - 1))
  }
  for (const root of roots) render(root, '', true)
  if (total) lines.push(`total cost: $${total.toFixed(6)}`)
  return lines.join('\n')
}

/** A per-agent emitter: tags events, assigns seq/time, forwards to the hub. */
export class AgentLog {
  #seq: number
  constructor(
    readonly hub: EventHub,
    readonly agentId: string,
    readonly parentId: string | null = null,
    /**
     * Last sequence number already used for this agent. A resumed session passes
     * its recorded maximum so a new run continues above it — otherwise (agentId,
     * seq) repeats across runs and consumers that dedupe by it lose events.
     */
    startSeq = 0,
  ) {
    this.#seq = startSeq
  }

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
