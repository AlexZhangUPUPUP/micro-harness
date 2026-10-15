/**
 * Pure event → view derivation. Keeping this out of the React components means
 * the tricky part (reconstructing a chat and an agent tree from an event stream)
 * is unit-testable without a browser.
 */

import type { TaggedEvent } from './api.ts'

export type ChatItem =
  | { kind: 'user'; id: string; t: number; text: string }
  | {
      kind: 'assistant'
      id: string
      t: number
      agentId: string
      text: string
      streaming: boolean
      input: number
      output: number
    }
  | { kind: 'tool'; id: string; t: number; agentId: string; name: string; args?: unknown; output?: string; ok?: boolean; ms?: number }
  | { kind: 'notice'; id: string; t: number; level: 'info' | 'error'; text: string }

/** Turn a session's event stream into a renderable transcript. */
export function deriveChat(events: TaggedEvent[]): ChatItem[] {
  const items: ChatItem[] = []
  const current = new Map<string, Extract<ChatItem, { kind: 'assistant' }>>()
  const toolById = new Map<string, Extract<ChatItem, { kind: 'tool' }>>()
  let n = 0
  const nextId = (p: string): string => `${p}-${++n}`

  for (const e of events) {
    const ev = e.event
    switch (ev.type) {
      case 'user.message': {
        items.push({ kind: 'user', id: nextId('u'), t: e.t, text: String(ev.content ?? ev.text ?? '') })
        current.delete(e.agentId)
        break
      }
      case 'text.delta': {
        let cur = current.get(e.agentId)
        if (!cur) {
          cur = { kind: 'assistant', id: nextId('a'), t: e.t, agentId: e.agentId, text: '', streaming: true, input: 0, output: 0 }
          items.push(cur)
          current.set(e.agentId, cur)
        }
        cur.text += String(ev.text ?? '')
        cur.streaming = true
        break
      }
      case 'tool.call': {
        current.delete(e.agentId)
        const card: Extract<ChatItem, { kind: 'tool' }> = {
          kind: 'tool',
          id: nextId('t'),
          t: e.t,
          agentId: e.agentId,
          name: String(ev.name ?? ''),
          args: ev.args,
        }
        items.push(card)
        if (ev.id) toolById.set(String(ev.id), card)
        break
      }
      case 'tool.result': {
        const card = ev.id ? toolById.get(String(ev.id)) : undefined
        if (card) {
          card.output = String(ev.output ?? '')
          card.ok = ev.ok !== false
          card.ms = Number(ev.ms ?? 0)
        } else {
          items.push({
            kind: 'tool',
            id: nextId('t'),
            t: e.t,
            agentId: e.agentId,
            name: String(ev.name ?? ''),
            output: String(ev.output ?? ''),
            ok: ev.ok !== false,
            ms: Number(ev.ms ?? 0),
          })
        }
        break
      }
      case 'turn.end': {
        const cur = current.get(e.agentId)
        if (cur) {
          cur.streaming = false
          if (!cur.text) cur.text = String(ev.text ?? '')
          current.delete(e.agentId)
        } else if (ev.text) {
          items.push({
            kind: 'assistant',
            id: nextId('a'),
            t: e.t,
            agentId: e.agentId,
            text: String(ev.text),
            streaming: false,
            input: 0,
            output: 0,
          })
        }
        break
      }
      case 'error': {
        items.push({ kind: 'notice', id: nextId('n'), t: e.t, level: 'error', text: String(ev.message ?? 'error') })
        break
      }
    }
  }
  return items
}

export interface AgentNode {
  agentId: string
  parentId: string | null
  input: number
  output: number
  cost: number
  tools: number
  errors: number
  status: 'active' | 'done' | 'error'
  depth: number
  children: AgentNode[]
  lastAt: number
}

export interface AgentTree {
  roots: AgentNode[]
  agents: AgentNode[]
  total: { input: number; output: number; cost: number }
}

/** Rebuild the multi-agent tree and per-agent usage from the tagged stream. */
export function deriveAgents(events: TaggedEvent[]): AgentTree {
  const map = new Map<string, AgentNode>()
  const ensure = (agentId: string, parentId: string | null): AgentNode => {
    let n = map.get(agentId)
    if (!n) {
      n = {
        agentId,
        parentId,
        input: 0,
        output: 0,
        cost: 0,
        tools: 0,
        errors: 0,
        status: 'active',
        depth: 0,
        children: [],
        lastAt: 0,
      }
      map.set(agentId, n)
    }
    if (parentId && !n.parentId) n.parentId = parentId
    return n
  }

  for (const e of events) {
    const node = ensure(e.agentId, e.parentId)
    node.lastAt = Math.max(node.lastAt, e.t)
    const ev = e.event
    if (ev.type === 'usage') {
      node.input += Number(ev.input ?? 0)
      node.output += Number(ev.output ?? 0)
      node.cost += Number(ev.cost ?? 0)
    } else if (ev.type === 'tool.result') {
      node.tools += 1
      if (ev.ok === false) node.errors += 1
    } else if (ev.type === 'turn.end') {
      node.status = 'done'
    } else if (ev.type === 'error') {
      node.status = 'error'
      node.errors += 1
    }
  }

  const agents = [...map.values()]
  const depthOf = (node: AgentNode, seen = new Set<string>()): number => {
    if (!node.parentId || seen.has(node.agentId)) return 0
    seen.add(node.agentId)
    const parent = map.get(node.parentId)
    return parent ? 1 + depthOf(parent, seen) : 1
  }
  for (const node of agents) node.depth = depthOf(node)
  for (const node of agents) {
    if (node.parentId) map.get(node.parentId)?.children.push(node)
  }
  const roots = agents.filter((node) => !node.parentId || !map.has(node.parentId))
  const total = agents.reduce(
    (acc, node) => ({ input: acc.input + node.input, output: acc.output + node.output, cost: acc.cost + node.cost }),
    { input: 0, output: 0, cost: 0 },
  )
  return { roots, agents, total }
}

/** Slice of the stream up to (and including) `upto` — powers the replay scrubber. */
export function truncate(events: TaggedEvent[], upto: number): TaggedEvent[] {
  return events.slice(0, Math.max(0, Math.min(upto, events.length)))
}
