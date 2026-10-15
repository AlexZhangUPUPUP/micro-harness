import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { applyHunkSelection, parseDiff } from '../src/patch.ts'

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
const N = 40

const repo = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-patch-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@example.com')
  git(dir, 'config', 'user.name', 't')
  return dir
}

const body = (changes: Record<number, string> = {}): string =>
  Array.from({ length: N }, (_, i) => changes[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

/**
 * A repo whose file changes on lines 3, 20 and 37 — far enough apart (3 context
 * lines each) that git emits three separate hunks.
 */
function fixture(): { base: string; diff: string; after: string } {
  const dir = repo()
  const base = body()
  writeFileSync(path.join(dir, 'a.txt'), base)
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  const after = body({ 3: 'CHANGED 3', 20: 'CHANGED 20', 37: 'CHANGED 37' })
  writeFileSync(path.join(dir, 'a.txt'), after)
  return { base, diff: git(dir, 'diff'), after }
}

test('parseDiff numbers hunks globally and attributes them to a path', () => {
  const { diff } = fixture()
  const parsed = parseDiff(diff)
  expect(parsed.hunks.length).toBe(3)
  expect(parsed.hunks.map((h) => h.index)).toEqual([0, 1, 2])
  expect(parsed.hunks.every((h) => h.file === 'a.txt')).toBe(true)
  expect(parsed.hunks.map((h) => h.oldStart)).toEqual([1, 17, 34])
})

test('accepting one hunk applies exactly that change', () => {
  const { base, diff } = fixture()
  const r = applyHunkSelection(base, diff, 'a.txt', [1])
  expect(r.content).toBe(body({ 20: 'CHANGED 20' }))
  expect(r.applied).toEqual([1])
  expect(r.conflicted).toEqual([])
})

test('accepting no hunks leaves the file byte-identical', () => {
  const { base, diff } = fixture()
  const r = applyHunkSelection(base, diff, 'a.txt', [])
  expect(r.content).toBe(base)
  expect(r.applied).toEqual([])
})

test('accepting every hunk reproduces the modified file', () => {
  const { base, diff, after } = fixture()
  const r = applyHunkSelection(base, diff, 'a.txt', [0, 1, 2])
  expect(r.content).toBe(after)
  expect(r.applied).toEqual([0, 1, 2])
})

test('accepting the first and last hunk only', () => {
  const { base, diff } = fixture()
  const r = applyHunkSelection(base, diff, 'a.txt', [0, 2])
  expect(r.content).toBe(body({ 3: 'CHANGED 3', 37: 'CHANGED 37' }))
  expect(r.applied).toEqual([0, 2])
})

test('a hunk whose context drifted is reported, never mis-applied', () => {
  const { diff } = fixture()
  // someone else already edited line 1, which is context for hunk 0
  const drifted = body({ 1: 'someone else got here first' })
  const r = applyHunkSelection(drifted, diff, 'a.txt', [0, 1, 2])
  expect(r.conflicted).toEqual([0])
  expect(r.applied).toEqual([1, 2])
  expect(r.content).toContain('someone else got here first')
  expect(r.content).toContain('line 3\n') // hunk 0 rejected
  expect(r.content).not.toContain('CHANGED 3\n') // (not a substring of CHANGED 37)
  expect(r.content).toContain('CHANGED 20')
})

test('a file with no hunks in the diff is returned untouched', () => {
  const { base, diff } = fixture()
  expect(applyHunkSelection(base, diff, 'other.txt', [0]).content).toBe(base)
})

test('a brand new file has an empty base and only additions', () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'keep.txt'), 'x\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  writeFileSync(path.join(dir, 'fresh.txt'), 'alpha\nbeta\n')
  git(dir, 'add', 'fresh.txt')
  const diff = git(dir, 'diff', '--cached')
  const parsed = parseDiff(diff)
  expect(parsed.hunks.length).toBe(1)
  expect(parsed.hunks[0]!.file).toBe('fresh.txt')
  expect(applyHunkSelection('', diff, 'fresh.txt', [0]).content).toBe('alpha\nbeta\n')
  expect(applyHunkSelection('', diff, 'fresh.txt', []).content).toBe('')
})

test('a deleted file reports deletion only when every hunk is accepted', () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'gone.txt'), 'a\nb\nc\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  git(dir, 'rm', '-q', 'gone.txt')
  const diff = git(dir, 'diff', '--cached')
  const parsed = parseDiff(diff)
  expect(parsed.deleted.has('gone.txt')).toBe(true)
  const hunk = parsed.hunks[0]!.index
  expect(applyHunkSelection('a\nb\nc\n', diff, 'gone.txt', [hunk]).deleted).toBe(true)
  expect(applyHunkSelection('a\nb\nc\n', diff, 'gone.txt', []).deleted).toBe(false)
  expect(applyHunkSelection('a\nb\nc\n', diff, 'gone.txt', []).content).toBe('a\nb\nc\n')
})
