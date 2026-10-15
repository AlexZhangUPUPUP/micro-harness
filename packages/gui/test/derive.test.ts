import { test, expect } from 'bun:test'
import { annotateDiff, deriveAgents, deriveChat, deriveUsageSeries, filterTrace, groupSessions, deriveInspector, messagePreview, splitDiffHunks, toMarkdown, truncate } from '../src/lib/derive.ts'
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

test('deriveChat records the event-array index in user.at', () => {
  const events = [
    ev('main', null, { type: 'text.delta', text: 'hi' }),
    ev('main', null, { type: 'user.message', content: 'first' }),
    ev('main', null, { type: 'text.delta', text: 'ok' }),
    ev('main', null, { type: 'user.message', content: 'second' }),
  ]
  const users = deriveChat(events).filter((i) => i.kind === 'user')
  expect(users.map((u) => (u.kind === 'user' ? u.at : -1))).toEqual([1, 3])
  expect(users.map((u) => (u.kind === 'user' ? u.text : ''))).toEqual(['first', 'second'])
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

test('annotateDiff numbers old/new lines per hunk', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    'index 1..2 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -10,3 +10,4 @@',
    ' keep',
    '-drop',
    '+add one',
    '+add two',
    ' tail',
  ].join('\n')
  const lines = annotateDiff(diff)
  const add = lines.filter((l) => l.kind === 'add')
  const del = lines.filter((l) => l.kind === 'del')
  const ctx = lines.filter((l) => l.kind === 'ctx')
  expect(add.map((l) => l.new)).toEqual([11, 12])
  expect(del.map((l) => l.old)).toEqual([11])
  // hunk says -10,3 +10,4 → 3 old lines (keep/drop/tail), 4 new (keep/add one/add two/tail)
  expect(ctx.map((l) => l.old)).toEqual([10, 12])
  expect(ctx.map((l) => l.new)).toEqual([10, 13])
  // hunk headers and file headers never get a line number
  expect(lines.filter((l) => l.kind === 'hunk' || l.kind === 'meta').every((l) => l.old === undefined && l.new === undefined)).toBe(true)
})

test('toMarkdown serializes a transcript', () => {
  const md = toMarkdown(
    [
      { kind: 'user', id: 'u1', t: 0, text: 'hi', at: 0 },
      { kind: 'assistant', id: 'a1', t: 0, agentId: 'main', text: '```ts\nx\n```', streaming: false, input: 1, output: 2 },
      { kind: 'tool', id: 't1', t: 0, agentId: 'main', name: 'read_file', args: { path: 'a' }, output: 'ok', ok: true },
    ],
    { id: 's1', title: 'My session', model: 'deepseek-chat' },
  )
  expect(md.startsWith('# My session')).toBe(true)
  expect(md).toContain('## You')
  expect(md).toContain('## Assistant')
  expect(md).toContain('### tool · `read_file`')
  expect(md).toContain('```ts\nx\n```') // assistant markdown passes through verbatim
  expect(md).toContain('deepseek-chat')
})

test('splitDiffHunks numbers hunks globally and restores markers', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    'index 1..2 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,3 @@',
    ' keep',
    '-old',
    '+new',
    '@@ -20,2 +20,3 @@',
    ' tail',
    '+extra',
  ].join('\n')
  const hunks = splitDiffHunks(diff)
  expect(hunks.map((h) => h.index)).toEqual([0, 1])
  expect(hunks.every((h) => h.file === 'a.txt')).toBe(true)
  expect(hunks[0]!.text.split('\n')).toEqual(['@@ -1,3 +1,3 @@', ' keep', '-old', '+new'])
  expect(hunks[1]!.text.split('\n')).toEqual(['@@ -20,2 +20,3 @@', ' tail', '+extra'])
})

test('splitDiffHunks handles several files', () => {
  const diff = ['+++ b/one.txt', '@@ -1 +1 @@', '-a', '+b', '+++ b/two.txt', '@@ -5 +5 @@', '-c', '+d'].join('\n')
  const hunks = splitDiffHunks(diff)
  expect(hunks.map((h) => h.file)).toEqual(['one.txt', 'two.txt'])
  expect(hunks.map((h) => h.index)).toEqual([0, 1])
})

test('deriveInspector collects the exact requests in order', () => {
  const events = [
    ev('main', null, { type: 'turn.start', turn: 1 }),
    ev('main', null, {
      type: 'model.request',
      model: 'deepseek-chat',
      system: 'you are a harness',
      tools: ['read_file', 'bash'],
      messages: [{ role: 'system', content: 'you are a harness' }, { role: 'user', content: 'hi' }],
      tokens: 42,
    }),
    ev('child', 'main', {
      type: 'model.request',
      model: 'deepseek-chat',
      system: 'you are a harness',
      tools: [],
      messages: [{ role: 'system', content: 'you are a harness' }],
      tokens: 9,
    }),
  ]
  const reqs = deriveInspector(events)
  expect(reqs.length).toBe(2)
  expect(reqs[0]!.agentId).toBe('main')
  expect(reqs[0]!.tools).toEqual(['read_file', 'bash'])
  expect(reqs[0]!.messages.length).toBe(2)
  expect(reqs[1]!.agentId).toBe('child')
  expect(deriveInspector([ev('main', null, { type: 'text.delta', text: 'x' })])).toEqual([])
})

test('messagePreview summarises each role', () => {
  expect(messagePreview({ role: 'user', content: 'hello   world' })).toBe('hello world')
  expect(messagePreview({ role: 'tool', name: 'read_file', content: 'line1\nline2' })).toBe('read_file: line1 line2')
  expect(
    messagePreview({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c', function: { name: 'write_file', arguments: '{}' } }],
    }),
  ).toBe('→ write_file')
})
