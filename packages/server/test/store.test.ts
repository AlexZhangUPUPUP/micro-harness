import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// SQLite 是主存储，兼容导出损坏时仍可直接读取完整事件。
test('reads canonical events when the JSONL export is missing', () => {
  const dir = sandbox()
  try {
    const store = new SessionStore(dir)
    const meta = store.create({ model: 'm' })
    store.append(meta.id, tag('main', null, 1, { type: 'user.message', text: 'canonical event' }))
    rmSync(store.eventsFile(meta.id))
    const reopened = new SessionStore(dir)
    expect(reopened.events(meta.id)).toHaveLength(1)
    expect(reopened.events(meta.id)[0]?.event.type).toBe('user.message')
    reopened.exportSession(meta.id)
    expect(existsSync(store.eventsFile(meta.id))).toBe(true)
    reopened.close()
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 兼容导出失败不能让调用方重复提交已经成功落库的事件。
test('records export failure after the SQLite transaction commits', () => {
  const dir = sandbox()
  try {
    const store = new SessionStore(dir)
    const meta = store.create({ model: 'm' })
    rmSync(store.dir(meta.id), { recursive: true, force: true })
    writeFileSync(store.dir(meta.id), 'blocked')
    store.append(meta.id, tag('main', null, 1, { type: 'user.message', text: 'sqlite wins' }))
    expect(store.events(meta.id)).toHaveLength(1)
    expect(store.exportStatus(meta.id).ok).toBe(false)
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 连续重建必须保持主、子 Agent 总用量稳定，同时保留人工元数据。
test('rebuilding repeatedly preserves usage totals and manually edited metadata', () => {
  // 准备包含主、子 Agent 用量和后续人工重命名的会话。
  const dir = sandbox()
  const store = new SessionStore(dir)
  try {
    const initial = store.create({ model: 'm', cwd: '/w', parentId: 'parent' })
    store.append(initial.id, tag('main', null, 1, { type: 'user.message', text: 'original title' }))
    store.append(initial.id, tag('main', null, 2, { type: 'usage', input: 100, output: 20, cost: 0.01 }))
    store.append(initial.id, tag('main/child', 'main', 1, { type: 'usage', input: 50, output: 10, cost: 0.02 }))
    const renamed = store.renameSession(initial.id, 'manual title')

    // 重复回放同一日志，索引和磁盘会话头都不得重复累计。
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(store.rebuild()).toBe(3)
      const restored = store.require(initial.id)
      expect(restored).toMatchObject({
        title: 'manual title', model: 'm', cwd: '/w', parentId: 'parent',
        createdAt: renamed.createdAt, input: 150, output: 30,
      })
      expect(restored.cost).toBeCloseTo(0.03)
      expect(JSON.parse(readFileSync(store.metaFile(initial.id), 'utf8'))).toEqual(restored)
      expect(store.events(initial.id)).toHaveLength(3)
    }
  } finally {
    // 关闭数据库后移除本用例的临时文件。
    store.close()
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

test('persists tool execution ledger and removes it with the session', () => {
  const dir = sandbox()
  try {
    const store = new SessionStore(dir)
    const meta = store.create({ model: 'm', cwd: '/w' })
    store.append(meta.id, tag('main', null, 1, { type: 'tool.call', id: 'c1', name: 'write_file', args: { path: 'x' } }))
    store.append(meta.id, tag('main', null, 2, { type: 'tool.status', id: 'c1', name: 'write_file', status: 'started' }))
    store.append(meta.id, tag('main', null, 3, { type: 'tool.result', id: 'c1', name: 'write_file', ok: true, output: 'done', ms: 2 }))
    expect(store.toolExecutions(meta.id)).toEqual([{ sessionId: meta.id, agentId: 'main', callId: 'c1', name: 'write_file', status: 'succeeded', reason: undefined, output: 'done', updatedAt: expect.any(Number) }])
    expect(store.delete(meta.id)).toBe(true)
    expect(store.list()).toEqual([])
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
