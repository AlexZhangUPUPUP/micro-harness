import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SessionStore, deriveMeta, ftsMatch } from '../src/store.ts'
import type { SessionMeta } from '../src/store.ts'
import { EventHub } from '@micro-harness/core'
import type { TaggedEvent } from '@micro-harness/core'

function sandbox(): string {
  return mkdtempSync(path.join(tmpdir(), 'mh-store-'))
}

function tag(agentId: string, parentId: string | null, seq: number, event: TaggedEvent['event']): TaggedEvent {
  return { agentId, parentId, seq, t: Date.now(), event }
}

test('deriveMeta folds events into a session header', () => {
  const base: SessionMeta = {
    id: 's',
    title: '',
    model: '',
    cwd: '',
    parentId: null,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    input: 0,
    output: 0,
    cost: 0,
  }
  let meta = deriveMeta(base, tag('main', null, 1, { type: 'session.start', model: 'm', cwd: '/w' }))
  meta = deriveMeta(meta, tag('main', null, 2, { type: 'user.message', text: '  fix the   bug ' }))
  meta = deriveMeta(meta, tag('main', null, 3, { type: 'usage', input: 10, output: 5, cost: 0.25 }))
  meta = deriveMeta(meta, tag('main', null, 4, { type: 'turn.end', stopReason: 'stop', text: 'done' }))
  expect(meta.model).toBe('m')
  expect(meta.cwd).toBe('/w')
  expect(meta.title).toBe('fix the bug')
  expect(meta.input).toBe(10)
  expect(meta.output).toBe(5)
  expect(meta.cost).toBe(0.25)
  expect(meta.status).toBe('done')
})

test('ftsMatch quotes terms and rejects empty queries', () => {
  expect(ftsMatch('')).toBeNull()
  expect(ftsMatch('   ')).toBeNull()
  expect(ftsMatch('hello world')).toBe('"hello" "world"')
  expect(ftsMatch('a "b"')).toBe('"a" """b"""')
})

test('stores sessions, appends events, and indexes them for full-text search', () => {
  const dir = sandbox()
  try {
    const store = new SessionStore(dir)
    const meta = store.create({ title: 'demo', model: 'deepseek-chat', cwd: '/tmp' })
    expect(store.list().map((s) => s.id)).toEqual([meta.id])
    expect(store.get(meta.id)?.title).toBe('demo')

    store.append(meta.id, tag('main', null, 1, { type: 'session.start', model: 'deepseek-chat', cwd: '/tmp' }))
    store.append(meta.id, tag('main', null, 2, { type: 'user.message', text: 'please refactor the parser' }))
    store.append(meta.id, tag('main', null, 3, { type: 'turn.end', stopReason: 'stop', text: 'refactored the parser module' }))

    const updated = store.get(meta.id)!
    expect(updated.status).toBe('done')
    expect(updated.title).toBe('demo')
    expect(store.events(meta.id).length).toBe(3)

    const hits = store.search('parser')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.sessionId === meta.id)).toBe(true)
    expect(store.search('nonexistent-term-xyz')).toEqual([])

    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('index is disposable: delete index.sqlite and rebuild from JSONL', () => {
  const dir = sandbox()
  try {
    let store = new SessionStore(dir)
    const meta = store.create({ model: 'm', cwd: '/w' })
    store.append(meta.id, tag('main', null, 1, { type: 'user.message', text: 'find the needle' }))
    store.append(meta.id, tag('main', null, 2, { type: 'turn.end', stopReason: 'stop', text: 'needle found' }))
    expect(store.search('needle').length).toBeGreaterThan(0)
    store.close()

    rmSync(path.join(dir, 'index.sqlite'), { force: true })
    rmSync(path.join(dir, 'index.sqlite-wal'), { force: true })
    rmSync(path.join(dir, 'index.sqlite-shm'), { force: true })

    store = new SessionStore(dir)
    expect(store.list().length).toBe(0)
    const count = store.rebuild()
    expect(count).toBe(2)
    expect(store.get(meta.id)?.title).toBe('find the needle')
    expect(store.events(meta.id).length).toBe(2)
    expect(store.search('needle').length).toBeGreaterThan(0)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deletes a session and its files', () => {
  const dir = sandbox()
  try {
    const store = new SessionStore(dir)
    const meta = store.create({ title: 'gone' })
    store.append(meta.id, tag('main', null, 1, { type: 'user.message', text: 'ephemeral' }))
    expect(existsSync(store.dir(meta.id))).toBe(true)
    expect(store.delete(meta.id)).toBe(true)
    expect(store.delete(meta.id)).toBe(false)
    expect(store.get(meta.id)).toBeUndefined()
    expect(existsSync(store.dir(meta.id))).toBe(false)
    expect(store.search('ephemeral')).toEqual([])
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('records real harness events through the hub and reconstructs history', async () => {
  const dir = sandbox()
  try {
    const store = new SessionStore(dir)
    const meta = store.create({ model: 'fake', cwd: dir })
    const hub = new EventHub()
    const off = hub.on((e) => store.append(meta.id, e))
    const { Harness } = await import('@micro-harness/core')
    const harness = new Harness({
      provider: { name: 'fake', async chat() { return { message: { role: 'assistant', content: 'hello there' } } } },
      model: 'fake',
      cwd: dir,
      hub,
    })
    await harness.send('say hi')
    off()
    const { reconstructMessages } = await import('@micro-harness/core')
    const messages = reconstructMessages(store.events(meta.id), 'sys')
    expect(messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(messages.some((m) => m.role === 'user' && m.content === 'say hi')).toBe(true)
    expect(messages.some((m) => m.role === 'assistant' && m.content === 'hello there')).toBe(true)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sub-agent events do not overwrite the session header', () => {
  const base: SessionMeta = {
    id: 's1',
    title: '',
    model: 'main-model',
    cwd: '/repo',
    parentId: null,
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    input: 0,
    output: 0,
    cost: 0,
  }
  const child = (seq: number, event: Record<string, unknown>): TaggedEvent => ({
    agentId: 'main/agent-1',
    parentId: 'main',
    seq,
    t: seq,
    event: event as TaggedEvent['event'],
  })

  const afterStart = deriveMeta(base, child(1, { type: 'session.start', model: 'child-model', cwd: '/worktree' }))
  expect(afterStart.model).toBe('main-model')
  expect(afterStart.cwd).toBe('/repo')

  // but a child's spend still counts toward the session total
  expect(deriveMeta(afterStart, child(2, { type: 'usage', input: 10, output: 5 })).input).toBe(10)

  // and a child finishing does not mark the whole session done
  expect(deriveMeta(afterStart, child(3, { type: 'turn.end', stopReason: 'stop', text: '' })).status).toBe('active')

  const mainEnd: TaggedEvent = { agentId: 'main', parentId: null, seq: 4, t: 4, event: { type: 'turn.end', stopReason: 'stop', text: '' } }
  expect(deriveMeta(afterStart, mainEnd).status).toBe('done')
})
