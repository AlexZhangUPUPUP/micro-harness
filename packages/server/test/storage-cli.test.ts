import { test, expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SessionStore } from '../src/store.ts'
import type { TaggedEvent } from '@micro-harness/core'

function tag(event: TaggedEvent['event']): TaggedEvent {
  return { agentId: 'main', parentId: null, seq: 1, t: Date.now(), event }
}

function runStorage(args: string[]): Record<string, unknown> {
  const output = execFileSync(process.execPath, ['run', path.resolve(import.meta.dir, '../src/storage-cli.ts'), ...args], { encoding: 'utf8' })
  return JSON.parse(output.trim()) as Record<string, unknown>
}

// 备份和恢复必须保留事件顺序、元数据和全文搜索可用性。
test('storage export and restore round-trip a session', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mh-storage-cli-'))
  const backup = path.join(root, 'backup')
  const restored = path.join(root, 'restored')
  try {
    const source = path.join(root, 'source')
    const store = new SessionStore(source)
    const meta = store.create({ title: 'manual title', model: 'm' })
    store.append(meta.id, tag({ type: 'user.message', text: 'portable event' }))
    store.close()
    expect(runStorage(['export', '--data-dir', source, '--out', backup]).events).toBe(1)
    expect(runStorage(['restore', '--from', backup, '--data-dir', restored]).events).toBe(1)
    const copy = new SessionStore(restored)
    expect(copy.require(meta.id).title).toBe('manual title')
    expect(copy.events(meta.id)[0]?.event.type).toBe('user.message')
    expect(copy.search('portable').length).toBe(1)
    copy.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 迁移命令对已经是 SQLite 主存储的目录必须幂等。
test('storage migrate is idempotent', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mh-storage-migrate-'))
  try {
    const store = new SessionStore(root)
    const meta = store.create({ model: 'm' })
    store.append(meta.id, tag({ type: 'user.message', text: 'once' }))
    store.close()
    expect(runStorage(['migrate', '--data-dir', root]).events).toBe(1)
    expect(runStorage(['migrate', '--data-dir', root]).events).toBe(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
