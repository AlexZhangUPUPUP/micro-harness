/**
 * Pure event → view derivation. Keeping this out of the React components means
 * the tricky part (reconstructing a chat and an agent tree from an event stream)
 * is unit-testable without a browser.
 */

import type { TaggedEvent } from './api.ts'

export type ChatItem =
  // `at` is the index of this event in the input `events` array (not its `seq`).
  // It is used to truncate a forked session when a user message is edited and resent.
  | { kind: 'user'; id: string; t: number; text: string; at: number; pending?: boolean }
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
/**
 * Merge local echoes (sent but not yet acknowledged) with the transcript.
 *
 * An echo disappears as soon as a recorded user message with the same text
 * exists — deriving this instead of relying on the SSE callback means a replay,
 * a missed frame or a re-subscribe can never leave a duplicate bubble. Matching
 * by count keeps a legitimately repeated prompt (e.g. "continue" twice) from
 * swallowing the second echo.
 */
export function withOptimistic(chat: ChatItem[], echoes: Array<{ id: string; text: string; t: number }>): ChatItem[] {
  const counts = new Map<string, number>()
  for (const item of chat) {
    if (item.kind !== 'user') continue
    const key = item.text.trim()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const pending: ChatItem[] = []
  for (const echo of echoes) {
    const key = echo.text.trim()
    const n = counts.get(key) ?? 0
    if (n > 0) {
      counts.set(key, n - 1)
      continue
    }
    pending.push({ kind: 'user', id: echo.id, t: echo.t, text: echo.text, at: -1, pending: true })
  }
  return [...chat, ...pending]
}

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
  /** Input tokens served from the provider's prompt cache. */
  cacheRead: number
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
  total: { input: number; output: number; cacheRead: number; cost: number }
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
        cacheRead: 0,
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
      node.cacheRead += Number(ev.cacheRead ?? 0)
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
    (acc, node) => ({
      input: acc.input + node.input,
      output: acc.output + node.output,
      cacheRead: acc.cacheRead + node.cacheRead,
      cost: acc.cost + node.cost,
    }),
    { input: 0, output: 0, cacheRead: 0, cost: 0 },
  )
  return { roots, agents, total }
}

/** Share of input tokens served from the provider's prompt cache (0–1). */
export function cacheHitRate(usage: { input: number; cacheRead?: number }): number {
  const input = Number(usage.input ?? 0)
  if (!input) return 0
  return Math.min(1, Number(usage.cacheRead ?? 0) / input)
}

/** Slice of the stream up to (and including) `upto` — powers the replay scrubber. */
export function truncate(events: TaggedEvent[], upto: number): TaggedEvent[] {
  return events.slice(0, Math.max(0, Math.min(upto, events.length)))
}

/** Tokens consumed per model call (input + output), in order — for a sparkline. */
export interface UsagePoint {
  t: number
  agentId: string
  model?: string
  input: number
  output: number
  cacheRead: number
  reasoning: number
  durationMs?: number
  cost: number
  /** False when the provider/pricing did not report a cost for this call. */
  hasCost: boolean
  total: number
  cumulative: number
}

export interface UsageCall extends UsagePoint {
  /** 1-based model-call index within the session. */
  index: number
  cacheHit: number | null
}

export type UsagePricing = 'full' | 'partial' | 'none'

export interface UsageSummary {
  input: number
  /** Input tokens not served from the provider cache (`input - cacheRead`). */
  newInput: number
  output: number
  cacheRead: number
  reasoning: number
  total: number
  cost: number
  pricing: UsagePricing
  /** Number of model calls, not user turns. */
  count: number
  avgPerCall: number
  peak: number
  cacheHit: number | null
  /** Mean model latency over calls that recorded it. */
  avgLatency: number | null
}

export interface UsageStats extends UsageSummary {
  calls: UsageCall[]
  /** Estimated context size of the most recent request, when recorded. */
  contextTokens: number | null
  agents: string[]
  models: string[]
}

/** Totals for a (possibly filtered) set of calls. */
export function summarizeCalls(calls: UsageCall[]): UsageSummary {
  let input = 0
  let output = 0
  let cacheRead = 0
  let reasoning = 0
  let cost = 0
  let priced = 0
  let latency = 0
  let latencyCount = 0
  for (const c of calls) {
    input += c.input
    output += c.output
    cacheRead += c.cacheRead
    reasoning += c.reasoning
    cost += c.cost
    if (c.hasCost) priced += 1
    if (c.durationMs != null) {
      latency += c.durationMs
      latencyCount += 1
    }
  }
  const count = calls.length
  const total = input + output
  return {
    input,
    newInput: Math.max(0, input - cacheRead),
    output,
    cacheRead,
    reasoning,
    total,
    cost,
    pricing: priced === 0 ? 'none' : priced === count ? 'full' : 'partial',
    count,
    avgPerCall: count ? Math.round(total / count) : 0,
    peak: calls.reduce((m, c) => Math.max(m, c.total), 0),
    cacheHit: input > 0 ? cacheRead / input : null,
    avgLatency: latencyCount ? Math.round(latency / latencyCount) : null,
  }
}

/** Per-call usage points plus the totals shown in the usage panel. */
export function deriveUsageStats(events: TaggedEvent[]): UsageStats {
  const points: UsageCall[] = []
  let cumulative = 0
  let contextTokens: number | null = null
  const agents = new Set<string>()
  const models = new Set<string>()
  for (const e of events) {
    if (e.event.type === 'model.request') {
      const tokens = Number((e.event as { tokens?: number }).tokens ?? 0)
      if (tokens > 0) contextTokens = tokens
      continue
    }
    if (e.event.type !== 'usage') continue
    const ev = e.event as {
      input?: number
      output?: number
      cacheRead?: number
      cost?: number
      reasoning?: number
      model?: string
      durationMs?: number
    }
    const i = Number(ev.input ?? 0)
    const o = Number(ev.output ?? 0)
    const c = Number(ev.cacheRead ?? 0)
    const r = Number(ev.reasoning ?? 0)
    const money = Number(ev.cost ?? 0)
    const total = i + o
    cumulative += total
    agents.add(e.agentId)
    const model = typeof ev.model === 'string' && ev.model ? ev.model : undefined
    if (model) models.add(model)
    points.push({
      t: e.t,
      agentId: e.agentId,
      ...(model ? { model } : {}),
      input: i,
      output: o,
      cacheRead: c,
      reasoning: r,
      ...(typeof ev.durationMs === 'number' ? { durationMs: ev.durationMs } : {}),
      cost: money,
      hasCost: ev.cost !== undefined,
      total,
      cumulative,
      index: points.length + 1,
      cacheHit: i > 0 ? c / i : null,
    })
  }
  const summary = summarizeCalls(points)
  return {
    ...summary,
    calls: points,
    contextTokens,
    agents: [...agents],
    models: [...models],
  }
}

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

export interface SessionTreeNode {
  session: SessionMeta
  depth: number
  children: SessionTreeNode[]
}

/**
 * Sessions nested by `parentId`. Roots are sessions whose parent is absent
 * (null, or pointing at a session that is not in the list). Malformed links
 * (self-parent, parent cycles) are demoted to roots so a broken tree can never
 * hang the UI.
 */
export function sessionForest(sessions: SessionMeta[]): SessionTreeNode[] {
  const byId = new Map<string, SessionMeta>()
  for (const s of sessions) byId.set(s.id, s)

  const nodes = new Map<string, SessionTreeNode>()
  for (const s of sessions) nodes.set(s.id, { session: s, depth: 0, children: [] })

  // Find the nodes that participate in a parent cycle (or point at themselves).
  // The parent graph is a functional graph (each node has at most one parent),
  // so a single walk with an on-path index map finds every cycle member.
  const cyclic = new Set<string>()
  const done = new Set<string>()
  const limit = sessions.length + 1
  for (const s of sessions) {
    if (done.has(s.id)) continue
    const path: string[] = []
    const at = new Map<string, number>()
    let cur: string | null = s.id
    while (cur !== null && path.length < limit) {
      if (done.has(cur) || cyclic.has(cur)) break
      const pos = at.get(cur)
      if (pos !== undefined) {
        // Revisited a node we are already walking → path[pos..] is a cycle.
        for (let i = pos; i < path.length; i++) cyclic.add(path[i])
        break
      }
      at.set(cur, path.length)
      path.push(cur)
      const meta = byId.get(cur)
      const pid = meta?.parentId
      if (!pid || pid === cur || !byId.has(pid)) break
      cur = pid
    }
    for (const id of path) done.add(id)
  }

  const roots: SessionTreeNode[] = []
  for (const s of sessions) {
    const node = nodes.get(s.id)
    if (!node) continue
    const pid = s.parentId
    const parent = pid ? byId.get(pid) : undefined
    if (!pid || !parent || pid === s.id || cyclic.has(s.id)) {
      roots.push(node)
    } else {
      nodes.get(pid)!.children.push(node)
    }
  }

  const assignDepth = (node: SessionTreeNode, depth: number): void => {
    node.depth = depth
    for (const child of node.children) assignDepth(child, depth + 1)
  }
  for (const root of roots) assignDepth(root, 0)

  return roots
}

/** Root → … → the given session; empty when it is unknown. */
export function ancestry(sessions: SessionMeta[], id: string | null): SessionMeta[] {
  if (!id) return []
  const byId = new Map<string, SessionMeta>()
  for (const s of sessions) byId.set(s.id, s)
  const chain: SessionMeta[] = []
  const seen = new Set<string>()
  let cur = byId.get(id)
  while (cur && !seen.has(cur.id) && chain.length <= sessions.length) {
    seen.add(cur.id)
    chain.push(cur)
    const pid = cur.parentId
    if (!pid || pid === cur.id) break
    cur = byId.get(pid)
  }
  chain.reverse()
  return chain
}

/** Descendant count, for a "+N" badge. */
export function descendantCount(node: SessionTreeNode): number {
  let count = 0
  const stack = [...node.children]
  while (stack.length > 0) {
    const child = stack.pop()!
    count += 1
    stack.push(...child.children)
  }
  return count
}

import type { SessionMeta } from './api.ts'
