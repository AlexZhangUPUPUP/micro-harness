import { expect, test } from 'bun:test'
import { createPermissionScope, type PermissionState } from '../src/lib/permissionState.ts'

/** 控制请求完成顺序以验证旧请求失效。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

/** 等待异步请求回调完成。 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** 记录权限状态及保存请求，不依赖界面渲染库。 */
function harness() {
  const load = deferred<string>()
  const save = deferred<unknown>()
  const states: PermissionState[] = []
  const saved: string[] = []
  const errors: unknown[] = []
  const scope = createPermissionScope({
    load: () => load.promise,
    save: (value) => { saved.push(value); return save.promise },
    publish: (state) => states.push(state),
    fail: (error) => errors.push(error),
  })
  return { load, save, states, saved, errors, scope }
}

test('权限加载期间未知且禁止保存，失败显示不可用', async () => {
  const current = harness()
  expect(current.states.at(-1)).toEqual({ status: 'loading', value: null })
  current.scope.change('full')
  expect(current.saved).toEqual([])
  current.load.reject(new Error('load failed'))
  await flush()
  expect(current.states.at(-1)).toEqual({ status: 'unavailable', value: null })
  current.scope.change('full')
  expect(current.saved).toEqual([])
  expect(current.errors).toHaveLength(1)
})

test('保存期间禁止重复请求，失败恢复已确认只读权限', async () => {
  const current = harness()
  current.load.resolve('read-only')
  await flush()
  current.scope.change('workspace')
  expect(current.states.at(-1)).toEqual({ status: 'saving', value: 'read-only' })
  current.scope.change('full')
  expect(current.saved).toEqual(['workspace'])
  current.save.reject(new Error('save failed'))
  await flush()
  expect(current.states.at(-1)).toEqual({ status: 'ready', value: 'read-only' })
  expect(current.errors).toHaveLength(1)
})

test('会话切换后旧读取不能覆盖当前权限', async () => {
  const old = harness()
  old.scope.dispose()
  const current = harness()
  current.load.resolve('read-only')
  await flush()
  old.load.resolve('full')
  await flush()
  expect(old.states).toEqual([{ status: 'loading', value: null }])
  expect(current.states.at(-1)).toEqual({ status: 'ready', value: 'read-only' })
})

test('保存绑定原作用域，切换后的成功或失败不能污染新会话', async () => {
  // 分别验证旧保存请求成功和失败的两种迟到结果。
  for (const fails of [false, true]) {
    const old = harness()
    old.load.resolve('read-only')
    await flush()
    old.scope.change('workspace')
    old.scope.dispose()
    const current = harness()
    current.load.resolve('read-only')
    await flush()
    if (fails) old.save.reject(new Error('old failure'))
    else old.save.resolve({ ok: true })
    await flush()
    expect(old.saved).toEqual(['workspace'])
    expect(old.states.at(-1)).toEqual({ status: 'saving', value: 'read-only' })
    expect(old.errors).toEqual([])
    expect(current.states.at(-1)).toEqual({ status: 'ready', value: 'read-only' })
  }
})
