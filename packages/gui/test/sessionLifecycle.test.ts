import { expect, test } from 'bun:test'
import { loadScoped, startSessionLifecycle } from '../src/lib/sessionLifecycle.ts'
import type { TaggedEvent } from '../src/lib/api.ts'

/** 手动控制请求完成顺序，复现切换会话后的延迟响应。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** 刷新 Promise 回调链，确保断言观察到异步结果。 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** 构造可区分归属的事件。 */
function event(seq: number): TaggedEvent {
  return { agentId: 'main', parentId: null, seq, t: seq, event: { type: 'text.delta', text: String(seq) } }
}

/** 记录快照、订阅以及错误，直接观察生命周期行为。 */
function harness(initial = [event(99)]) {
  const request = deferred<{ events: TaggedEvent[] }>()
  let events = initial
  let handlers!: { onEvent: (value: TaggedEvent) => void; onError: () => void }
  const errors: unknown[] = []
  const received: TaggedEvent[] = []
  let closed = false
  const stop = startSessionLifecycle({
    load: () => request.promise,
    subscribe: (value) => { handlers = value; return () => { closed = true } },
    replace: (value) => { events = value },
    append: (value) => { events = [...events, value] },
    receive: (value) => { received.push(value) },
    fail: (error) => { errors.push(error) },
  })
  return { request, handlers, errors, received, stop, events: () => events, closed: () => closed }
}

test('切换会话后忽略旧快照成功、事件及连接错误', async () => {
  const old = harness()
  expect(old.events()).toEqual([])
  old.stop()
  old.request.resolve({ events: [event(1)] })
  old.handlers.onEvent(event(2))
  old.handlers.onError()
  await flush()
  expect(old.events()).toEqual([])
  expect(old.received).toEqual([])
  expect(old.errors).toEqual([])
  expect(old.closed()).toBe(true)
})

test('切换会话后忽略旧快照失败', async () => {
  const old = harness()
  old.stop()
  old.request.reject(new Error('old failure'))
  await flush()
  expect(old.events()).toEqual([])
  expect(old.errors).toEqual([])
})

test('当前快照失败可见且不会保留上一会话内容，流仍可继续', async () => {
  const current = harness()
  current.handlers.onEvent(event(1))
  current.request.reject(new Error('snapshot failed'))
  await flush()
  expect(current.events()).toEqual([event(1)])
  expect(current.errors.map(String)).toEqual(['Error: snapshot failed'])
  current.handlers.onEvent(event(2))
  expect(current.events()).toEqual([event(1), event(2)])
  current.stop()
})

test('快照合并加载期间事件并去除重复', async () => {
  const current = harness()
  current.handlers.onEvent(event(1))
  current.handlers.onEvent(event(2))
  current.request.resolve({ events: [event(1)] })
  await flush()
  expect(current.events()).toEqual([event(1), event(2)])
  current.stop()
})

test('作用域请求忽略旧权限或命令响应，保留当前响应', async () => {
  const old = deferred<string>()
  const current = deferred<string>()
  const values: string[] = []
  const errors: unknown[] = []
  const cancel = loadScoped(() => old.promise, (value) => values.push(value), (error) => errors.push(error))
  cancel()
  loadScoped(() => current.promise, (value) => values.push(value), (error) => errors.push(error))
  current.resolve('current')
  await flush()
  old.resolve('old')
  await flush()
  expect(values).toEqual(['current'])
  expect(errors).toEqual([])
})
