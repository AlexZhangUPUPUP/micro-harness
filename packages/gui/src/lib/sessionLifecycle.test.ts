import { test, expect } from 'bun:test'
import { startSessionLifecycle } from './sessionLifecycle.ts'
import type { TaggedEvent } from './api.ts'

const event: TaggedEvent = { agentId: 'main', parentId: null, seq: 1, t: 1, event: { type: 'context.snapshot' } }

/** 创建最小生命周期依赖，测试正常结束和异常断开必须分流。 */
function deps() {
  const calls = { fail: 0, end: 0, events: 0 }
  const options = {
    load: async () => ({ events: [event] }),
    subscribe: (handlers: { onEvent: (value: TaggedEvent) => void; onError: () => void; onEnd?: () => void }) => {
      handlers.onEvent(event)
      return () => undefined
    },
    replace: () => undefined,
    append: () => undefined,
    receive: () => { calls.events += 1 },
    fail: () => { calls.fail += 1 },
    onEnd: () => { calls.end += 1 },
  }
  return { options, calls }
}

test('正常结束不会产生断开错误', async () => {
  const state = deps()
  const stop = startSessionLifecycle({ ...state.options, subscribe: (handlers) => { handlers.onEnd?.(); return () => undefined } })
  await Promise.resolve()
  expect(state.calls.fail).toBe(0)
  expect(state.calls.end).toBe(1)
  stop()
})

test('异常断开仍然报告错误', () => {
  const state = deps()
  const stop = startSessionLifecycle({ ...state.options, subscribe: (handlers) => { handlers.onError(); return () => undefined } })
  expect(state.calls.fail).toBe(1)
  stop()
})
