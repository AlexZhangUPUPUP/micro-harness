import { describe, expect, test } from 'bun:test'
import { applyTaskUpdate, createTaskSnapshot, deriveTaskState, validateTaskSnapshot } from '../../src/task/plan.ts'

describe('structured task state', () => {
  test('applies explicit updates and rejects stale revisions', () => {
    const initial = createTaskSnapshot(1)
    const next = applyTaskUpdate(initial, { goal: '完成接口', status: 'running', expectedRevision: 0 }, 2)
    expect(next.revision).toBe(1)
    expect(() => applyTaskUpdate(next, { status: 'completed', expectedRevision: 0 })).toThrow('revision conflict')
  })

  test('rebuilds the latest valid snapshot from events', () => {
    const first = applyTaskUpdate(createTaskSnapshot(), { goal: '旧目标' })
    const second = applyTaskUpdate(first, { goal: '新目标', status: 'completed' })
    const state = deriveTaskState([{ event: { type: 'task.update', snapshot: first } }, { event: { type: 'task.update', snapshot: second } }])
    expect(state.goal).toBe('新目标')
    expect(validateTaskSnapshot(state)).toBe(true)
  })
})
