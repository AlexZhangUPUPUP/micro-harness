import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dispatch, makeTools, type ToolContext } from '../src/tools.ts'

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'micro-harness-'))
}

test('write_file then read_file round-trips inside the sandbox', async () => {
  const dir = await sandbox()
  try {
    const tools = makeTools()
    const ctx: ToolContext = { cwd: dir, allowBash: false }
    const w = await dispatch(tools, 'write_file', JSON.stringify({ path: 'a/b.txt', content: 'hello\nworld' }), ctx)
    assert.equal(w.isError, undefined)
    const r = await dispatch(tools, 'read_file', JSON.stringify({ path: 'a/b.txt' }), ctx)
    assert.match(r.output, /hello/)
    assert.match(r.output, /world/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('list_dir lists entries and marks directories', async () => {
  const dir = await sandbox()
  try {
    const tools = makeTools()
    const ctx: ToolContext = { cwd: dir, allowBash: false }
    await dispatch(tools, 'write_file', JSON.stringify({ path: 'sub/x.txt', content: 'x' }), ctx)
    const out = await dispatch(tools, 'list_dir', '{}', ctx)
    assert.match(out.output, /sub\//)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('path traversal is refused', async () => {
  const dir = await sandbox()
  try {
    const r = await dispatch(makeTools(), 'read_file', JSON.stringify({ path: '../outside.txt' }), { cwd: dir, allowBash: false })
    assert.equal(r.isError, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('bash is off by default and unknown tools fail cleanly', async () => {
  const tools = makeTools()
  const ctx: ToolContext = { cwd: process.cwd(), allowBash: false }
  const bash = await dispatch(tools, 'bash', JSON.stringify({ command: 'echo hi' }), ctx)
  assert.equal(bash.isError, true)
  const unknown = await dispatch(tools, 'nope', '{}', ctx)
  assert.equal(unknown.isError, true)
})
