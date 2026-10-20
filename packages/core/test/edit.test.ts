import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { dispatch, makeTools, type ToolContext } from '../src/tools.ts'

async function setup(content: string): Promise<{ dir: string; ctx: ToolContext; tools: ReturnType<typeof makeTools> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-edit-'))
  await writeFile(path.join(dir, 'a.txt'), content)
  return { dir, ctx: { cwd: dir, allowBash: false }, tools: makeTools() }
}

const edit = (tools: ReturnType<typeof makeTools>, ctx: ToolContext, args: unknown) =>
  dispatch(tools, 'edit_file', JSON.stringify(args), ctx)

test('edit_file replaces a unique match and leaves the rest untouched', async () => {
  const { dir, ctx, tools } = await setup('one\ntwo\nthree\n')
  try {
    const res = await edit(tools, ctx, { path: 'a.txt', old_string: 'two', new_string: 'TWO' })
    assert.equal(res.isError, undefined)
    assert.match(res.output, /replaced 1 occurrence/)
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('edit_file refuses a missing match and does not write', async () => {
  const { dir, ctx, tools } = await setup('alpha\n')
  try {
    const res = await edit(tools, ctx, { path: 'a.txt', old_string: 'nope', new_string: 'x' })
    assert.equal(res.isError, true)
    assert.match(res.output, /not found/)
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'alpha\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('edit_file refuses an ambiguous match unless replace_all is set', async () => {
  const { dir, ctx, tools } = await setup('x\nx\n')
  try {
    const ambiguous = await edit(tools, ctx, { path: 'a.txt', old_string: 'x', new_string: 'y' })
    assert.equal(ambiguous.isError, true)
    assert.match(ambiguous.output, /matches 2 times/)
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'x\nx\n')

    const all = await edit(tools, ctx, { path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true })
    assert.equal(all.isError, undefined)
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'y\ny\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('edit_file treats $& in the replacement literally', async () => {
  const { dir, ctx, tools } = await setup('value = 1\n')
  try {
    const res = await edit(tools, ctx, { path: 'a.txt', old_string: '1', new_string: '$&2' })
    assert.equal(res.isError, undefined)
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'value = $&2\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('edit_file rejects identical strings and missing files', async () => {
  const { dir, ctx, tools } = await setup('same\n')
  try {
    const same = await edit(tools, ctx, { path: 'a.txt', old_string: 'same', new_string: 'same' })
    assert.equal(same.isError, true)
    assert.match(same.output, /identical/)

    const missing = await edit(tools, ctx, { path: 'nope.txt', old_string: 'a', new_string: 'b' })
    assert.equal(missing.isError, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
