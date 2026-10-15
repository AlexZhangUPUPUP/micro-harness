import { test, expect } from 'bun:test'
import { pendingApprovals, isResolved } from '../src/lib/approvals.ts'
import type { TaggedEvent } from '../src/lib/api.ts'

let seq = 0
const ev = (agentId: string, event: { type: string; [k: string]: unknown }, t = ++seq): TaggedEvent => ({
  agentId,
  parentId: null,
  seq,
  t,
  event,
})

test('a permission.request with no result is pending', () => {
  const events = [ev('main', { type: 'permission.request', id: 'perm:c1', tool: 'bash', args: { cmd: 'ls' } })]
  const pending = pendingApprovals(events)
  expect(pending).toHaveLength(1)
  expect(pending[0]!.id).toBe('perm:c1')
  expect(pending[0]!.tool).toBe('bash')
  expect(pending[0]!.args).toEqual({ cmd: 'ls' })
  expect(pending[0]!.agentId).toBe('main')
})

test('after a matching permission.result it is not pending', () => {
  const events = [
    ev('main', { type: 'permission.request', id: 'perm:c1', tool: 'bash', args: {} }),
    ev('main', { type: 'permission.result', id: 'perm:c1', decision: 'allow' }),
  ]
  expect(pendingApprovals(events)).toEqual([])
  expect(isResolved(events, 'perm:c1')).toBe(true)
})

test('several requests with mixed results', () => {
  const events = [
    ev('main', { type: 'permission.request', id: 'perm:a', tool: 'write_file', args: { path: 'a' } }),
    ev('main', { type: 'permission.request', id: 'perm:b', tool: 'bash', args: { cmd: 'x' } }),
    ev('main', { type: 'permission.result', id: 'perm:a', decision: 'allow' }),
    ev('main', { type: 'permission.request', id: 'perm:c', tool: 'bash', args: {} }),
    ev('main', { type: 'permission.result', id: 'perm:c', decision: 'deny' }),
  ]
  expect(pendingApprovals(events).map((p) => p.id)).toEqual(['perm:b'])
  expect(isResolved(events, 'perm:a')).toBe(true)
  expect(isResolved(events, 'perm:b')).toBe(false)
  expect(isResolved(events, 'perm:c')).toBe(true)
})

test('an empty stream yields []', () => {
  expect(pendingApprovals([])).toEqual([])
})
