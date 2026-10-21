import { test, expect } from 'bun:test'
import { approvalDiff, lineDiff } from '../src/lib/approvalDiff.ts'

test('lineDiff marks removed, added and unchanged lines', () => {
  const diff = lineDiff('a\nb\nc', 'a\nB\nc')
  expect(diff).toEqual([
    { kind: 'ctx', text: 'a' },
    { kind: 'del', text: 'b' },
    { kind: 'add', text: 'B' },
    { kind: 'ctx', text: 'c' },
  ])
})

test('approvalDiff handles a single edit and a batch', () => {
  expect(approvalDiff('edit_file', { old_string: 'x', new_string: 'y' })).toEqual([
    { kind: 'del', text: 'x' },
    { kind: 'add', text: 'y' },
  ])
  const batch = approvalDiff('edit_file', {
    edits: [
      { old_string: 'a', new_string: 'A' },
      { old_string: 'b', new_string: 'B' },
    ],
  })
  expect(batch?.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['A', 'B'])
})

test('approvalDiff writes a full-file diff when the old content is available', () => {
  const diff = approvalDiff('write_file', { content: 'one\ntwo' }, 'one\ntwo\nthree')
  expect(diff?.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['three'])
  expect(approvalDiff('write_file', { content: 'new' })).toEqual([{ kind: 'add', text: 'new' }])
  expect(approvalDiff('bash', { command: 'ls' })).toBeNull()
})
