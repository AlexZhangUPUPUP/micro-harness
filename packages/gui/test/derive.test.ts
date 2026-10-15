import { test, expect } from 'bun:test'
import { deriveAgents, deriveChat, deriveUsageSeries, filterTrace, groupSessions, truncate } from '../src/lib/derive.ts'
import type { TaggedEvent } from '../src/lib/api.ts'

let seq = 0
const ev = (agentId: string, parentId: string | null, event: { type: string; [k: string]: unknown }, t = ++seq): TaggedEvent => ({
  agentId,
  parentId,
  seq,
  t,
  event,
})

const stream: TaggedEvent[] = [
  ev('main', null, { type: 'session.start', model: 'm', cwd: '/x' }),
  ev('main', null, { type: 'turn.start', turn: 1 }),
  ev('main', null, { type: 'user.message', content: 'delegate please' }),
  ev('main', null, { type: 'text.delta', text: 'I will ' }),
  ev('main', null, { type: 'text.delta', text: 'delegate.' }),
  ev('main', null, { type: 'usage', input: 100, output: 20 }),
  ev('main', null, { type: 'tool.call', id: 'c1', name: 'task', args: { mode: 'single' } }),
  ev('main/main/agent-1', 'main', { type: 'session.start', model: 'm', cwd: '/x' }),
  ev('main/main/agent-1', 'main', { type: 'text.delta', text: 'SUBOK' }),
  ev('main/main/agent-1', 'main', { type: 'usage', input: 30, output: 2 }),
  ev('main/main/agent-1', 'main', { type: 'turn.end', stopReason: 'stop', text: 'SUBOK' }),
  ev('main', null, { type: 'tool.result', id: 'c1', name: 'task', ok: true, output: 'SUBOK', ms: 12 }),
  ev('main', null, { type: 'text.delta', text: 'Done.' }),
  ev('main', null, { type: 'turn.end', stopReason: 'stop', text: 'Done.' }),
]

test('deriveChat builds user, assistant and tool items in order', () => {
  const items = deriveChat(stream)
  expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'assistant', 'assistant'])
  const [user, first, tool, child, last] = items
  expect(user!.kind === 'user' && user.text).toBe('delegate please')
  expect(first!.kind === 'assistant' && first.text).toBe('I will delegate.')
  expect(tool!.kind === 'tool' && tool.name).toBe('task')
  expect(tool!.kind === 'tool' && tool.ok).toBe(true)
  expect(tool!.kind === 'tool' && tool.ms).toBe(12)
  // the sub-agent's own answer is rendered as a child bubble
  expect(child!.kind === 'assistant' && child.agentId).not.toBe('main')
  expect(child!.kind === 'assistant' && child.text).toBe('SUBOK')
  expect(last!.kind === 'assistant' && last.text).toBe('Done.')
  expect(last!.kind === 'assistant' && last.streaming).toBe(false)
})

test('deriveChat turns errors into notices', () => {
  const items = deriveChat([ev('main', null, { type: 'error', message: 'boom' })])
  expect(items).toHaveLength(1)
  expect(items[0]!.kind === 'notice' && items[0]!.level).toBe('error')
})

test('deriveAgents rebuilds the tree with per-agent usage', () => {
  const tree = deriveAgents(stream)
  expect(tree.agents.length).toBe(2)
  const main = tree.agents.find((a) => a.agentId === 'main')!
  const child = tree.agents.find((a) => a.agentId !== 'main')!
  expect(main.parentId).toBeNull()
  expect(child.parentId).toBe('main')
  expect(child.depth).toBe(1)
  expect(child.status).toBe('done')
  expect(child.input).toBe(30)
  expect(child.output).toBe(2)
  expect(child.tools).toBe(0)
  expect(main.tools).toBe(1)
  expect(tree.roots).toHaveLength(1)
  expect(tree.roots[0]!.children.map((c) => c.agentId)).toContain(child.agentId)
  expect(tree.total.input).toBe(130)
  expect(tree.total.output).toBe(22)
})

test('truncate powers the replay scrubber', () => {
  const half = truncate(stream, 7)
  expect(half).toHaveLength(7)
  expect(deriveChat(half).some((i) => i.kind === 'tool')).toBe(true)
  // the child has not been seen yet at seq 7
  expect(deriveAgents(half).agents.length).toBe(1)
})

test('deriveUsageSeries collects tokens per model call', () => {
  const events = [
    ev('main', null, { type: 'usage', input: 10, output: 5 }),
    ev('main', null, { type: 'text.delta', text: 'x' }),
    ev('main', null, { type: 'usage', input: 20, output: 8 }),
  ]
  expect(deriveUsageSeries(events)).toEqual([15, 28])
})

test('filterTrace filters by category, agent and text', () => {
  const events = [
    ev('main', null, { type: 'text.delta', text: 'hello world' }),
    ev('main', null, { type: 'tool.call', id: 'c', name: 'write_file', args: { path: 'a' } }),
    ev('child', 'main', { type: 'tool.result', id: 'c', name: 'write_file', ok: true, output: 'ok', ms: 1 }),
    ev('main', null, { type: 'error', message: 'boom' }),
  ]
  expect(filterTrace(events, { category: 'tool' }).length).toBe(2)
  expect(filterTrace(events, { agentId: 'child' }).length).toBe(1)
  expect(filterTrace(events, { q: 'boom' }).length).toBe(1)
  expect(filterTrace(events, { category: 'all' }).length).toBe(4)
})

test('groupSessions buckets by day', () => {
  const now = new Date('2026-10-15T12:00:00').getTime()
  const day = 86_400_000
  const sessions = [
    { id: 'a', updatedAt: now - 1000 },
    { id: 'b', updatedAt: now - day },
    { id: 'c', updatedAt: now - 5 * day },
  ]
  const groups = groupSessions(sessions, now)
  expect(groups.map((g) => g.key)).toEqual(['today', 'yesterday', 'earlier'])
  expect(groups[0]!.items.map((s) => s.id)).toEqual(['a'])
})
