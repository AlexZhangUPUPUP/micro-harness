import { test, expect } from 'bun:test'
import { IncrementalTaskProjector } from './derive.ts'
import type { TaggedEvent } from './api.ts'

const event = (revision: number, status: 'queued' | 'running' | 'completed'): TaggedEvent => ({
  agentId: 'main', parentId: null, seq: revision, t: revision,
  event: { type: 'task.update', snapshot: { version: 1, revision, goal: 'demo', status, constraints: [], steps: [], verifications: [], blockers: [], updatedAt: revision } },
})

test('incremental task projection consumes only appended events and resets on history switch', () => {
  const projector = new IncrementalTaskProjector()
  expect(projector.update([event(1, 'running')]).status).toBe('running')
  expect(projector.update([event(1, 'running'), event(2, 'completed')]).status).toBe('completed')
  expect(projector.update([event(9, 'queued')]).status).toBe('queued')
})
