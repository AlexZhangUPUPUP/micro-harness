/**
 * Pure event → view derivation. Keeping this out of the React components means
 * the tricky part (reconstructing a chat and an agent tree from an event stream)
 * is unit-testable without a browser.
 */

import type { TaggedEvent } from './api.ts'

export type ChatItem =
  // `at` is the index of this event in the input `events` array (not its `seq`).
  // It is used to truncate a forked session when a user message is edited and resent.
  | { kind: 'user'; id: string; t: number; text: string; at: number }
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

  for (const [i, e] of events.entries()) {
    const ev = e.event
    switch (ev.type) {
      case 'user.message': {
        items.push({ kind: 'user', id: nextId('u'), t: e.t, text: String(ev.content ?? ev.text ?? ''), at: i })
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
  /** Set when the agent ran in its own git worktree. */
  worktree?: { path: string; branch: string; base: string } | null
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
    } else if (ev.type === 'agent.worktree') {
      node.worktree = { path: String(ev.path ?? ''), branch: String(ev.branch ?? ''), base: String(ev.base ?? '') }
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

/** Tokens consumed per model call (input + output), in order — for a sparkline. */
export function deriveUsageSeries(events: TaggedEvent[]): number[] {
  const out: number[] = []
  for (const e of events) {
    if (e.event.type === 'usage') out.push(Number(e.event.input ?? 0) + Number(e.event.output ?? 0))
  }
  return out
}

export type TraceCategory = 'all' | 'text' | 'tool' | 'usage' | 'error' | 'other'

export function traceCategory(type: string): Exclude<TraceCategory, 'all'> {
  if (type.startsWith('tool.')) return 'tool'
  if (type.startsWith('text.') || type.startsWith('thinking.')) return 'text'
  if (type === 'usage') return 'usage'
  if (type === 'error') return 'error'
  return 'other'
}

export interface TraceFilter {
  category?: TraceCategory
  agentId?: string | null
  q?: string
}

/** Filter the trace by category, agent and free text (pure). */
export function filterTrace(events: TaggedEvent[], filter: TraceFilter): TaggedEvent[] {
  const q = (filter.q ?? '').trim().toLowerCase()
  const cat = filter.category ?? 'all'
  return events.filter((e) => {
    if (filter.agentId && e.agentId !== filter.agentId) return false
    if (cat !== 'all' && traceCategory(e.event.type) !== cat) return false
    if (q) {
      const hay = `${e.agentId} ${e.event.type} ${JSON.stringify(e.event)}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

export type SessionBucket = 'today' | 'yesterday' | 'earlier'

/** Group sessions into Today / Yesterday / Earlier by `updatedAt` (pure). */
export function groupSessions<T extends { updatedAt: number }>(
  sessions: T[],
  now = Date.now(),
): Array<{ key: SessionBucket; items: T[] }> {
  const startOfDay = (t: number): number => {
    const d = new Date(t)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const today = startOfDay(now)
  const yesterday = today - 86_400_000
  const buckets: Record<SessionBucket, T[]> = { today: [], yesterday: [], earlier: [] }
  for (const s of sessions) {
    if (s.updatedAt >= today) buckets.today.push(s)
    else if (s.updatedAt >= yesterday) buckets.yesterday.push(s)
    else buckets.earlier.push(s)
  }
  return (['today', 'yesterday', 'earlier'] as const)
    .filter((k) => buckets[k].length > 0)
    .map((key) => ({ key, items: buckets[key] }))
}

export interface DiffLine {
  kind: 'file' | 'hunk' | 'meta' | 'add' | 'del' | 'ctx'
  old?: number
  new?: number
  text: string
}

/** Split a unified diff into lines, tracking old/new line numbers per hunk. */
export function annotateDiff(text: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
      }
      out.push({ kind: 'hunk', text: line })
      continue
    }
    const kind: DiffLine['kind'] =
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('new file') ||
      line.startsWith('deleted file') ||
      line.startsWith('\\')
        ? 'file'
        : line.startsWith('+++') || line.startsWith('---')
          ? 'meta'
          : line.startsWith('+')
            ? 'add'
            : line.startsWith('-')
              ? 'del'
              : 'ctx'
    if (kind === 'add') out.push({ kind, new: newNo++, text: line.slice(1) })
    else if (kind === 'del') out.push({ kind, old: oldNo++, text: line.slice(1) })
    // strip the leading marker space too, so every DiffLine.text is pure content
    else if (kind === 'ctx') out.push({ kind, old: oldNo++, new: newNo++, text: line.slice(1) })
    else out.push({ kind, text: line })
  }
  return out
}

/** Serialize a transcript to Markdown (export / clipboard). */
export function toMarkdown(items: ChatItem[], meta: { title?: string; id?: string; model?: string } = {}): string {
  const lines: string[] = [`# ${meta.title?.trim() || meta.id || 'micro-harness session'}`, '']
  const sub: string[] = []
  if (meta.model) sub.push(`model: \`${meta.model}\``)
  if (meta.id) sub.push(`session: \`${meta.id}\``)
  lines.push(`> ${sub.join(' · ') || 'micro-harness'}`, '')
  const fence = (body: string, lang = ''): string => {
    const f = body.includes('```') ? '````' : '```'
    return `${f}${lang}\n${body}\n${f}`
  }
  for (const it of items) {
    if (it.kind === 'user') lines.push('## You', '', it.text, '')
    else if (it.kind === 'assistant')
      lines.push(`## Assistant${it.agentId === 'main' ? '' : ` (${it.agentId})`}`, '', it.text, '')
    else if (it.kind === 'notice') lines.push(`> [!${it.level === 'error' ? 'ERROR' : 'NOTE'}] ${it.text}`, '')
    else {
      lines.push(`### tool · \`${it.name}\`${it.ok === false ? ' (failed)' : ''}`, '')
      if (it.args !== undefined) lines.push(fence(JSON.stringify(it.args, null, 2), 'json'), '')
      if (it.output) lines.push(fence(it.output.slice(0, 4000)), '')
    }
  }
  return lines.join('\n')
}

export interface DiffHunk {
  /** Global index across the diff — the same numbering `applyHunkSelection` uses. */
  index: number
  header: string
  file: string
  /** This hunk's lines, with the original +/-/space markers restored. */
  text: string
  lines: DiffLine[]
}

const SIGN: Record<string, string> = { add: '+', del: '-', ctx: ' ' }

/**
 * Split a unified diff into individually-selectable hunks. Hunks are numbered by
 * the order `@@` appears, which is exactly how the server numbers them.
 */
export function splitDiffHunks(diff: string): DiffHunk[] {
  const out: DiffHunk[] = []
  let file = ''
  let current: DiffHunk | null = null
  for (const line of annotateDiff(diff)) {
    if (line.kind === 'meta' && line.text.startsWith('+++ ')) {
      const target = line.text.slice(4).trim()
      if (target !== '/dev/null') file = target.replace(/^\w\//, '')
      continue
    }
    if (line.kind === 'hunk') {
      current = { index: out.length, header: line.text, file, text: line.text, lines: [] }
      out.push(current)
      continue
    }
    if (!current) continue
    if (line.kind === 'file' || line.kind === 'meta') continue
    current.lines.push(line)
    current.text += '\n' + (SIGN[line.kind] ?? ' ') + line.text
  }
  return out
}

export interface RequestMessage {
  role: string
  content?: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: unknown
}

export interface ModelRequest {
  agentId: string
  t: number
  model: string
  system: string
  tools: string[]
  messages: RequestMessage[]
  /** The harness's own estimate of the payload it sent. */
  tokens: number
}

/** The exact payloads handed to the model, oldest first (the Inspector). */
export function deriveInspector(events: TaggedEvent[]): ModelRequest[] {
  const out: ModelRequest[] = []
  for (const e of events) {
    if (e.event.type !== 'model.request') continue
    const ev = e.event as {
      model?: string
      system?: string
      tools?: string[]
      messages?: unknown[]
      tokens?: number
    }
    out.push({
      agentId: e.agentId,
      t: e.t,
      model: ev.model ?? '',
      system: ev.system ?? '',
      tools: ev.tools ?? [],
      messages: (ev.messages ?? []) as RequestMessage[],
      tokens: ev.tokens ?? 0,
    })
  }
  return out
}

/** One-line summary of a message, for the inspector's list. */
export function messagePreview(m: RequestMessage, max = 120): string {
  const calls = m.tool_calls
  if (Array.isArray(calls) && calls.length) {
    const names = calls
      .map((c) => (c as { function?: { name?: string } }).function?.name)
      .filter((n): n is string => Boolean(n))
    return `→ ${names.join(', ') || 'tool_call'}`
  }
  const body = String(m.content ?? '').replace(/\s+/g, ' ').trim()
  if (m.role === 'tool') return `${m.name ?? 'tool'}: ${body.slice(0, max)}`
  return body.slice(0, max)
}
