/** 权限只有服务端确认后才可展示为已生效。 */
export type PermissionState = { status: 'loading' | 'ready' | 'saving' | 'unavailable'; value: string | null }

/** 将权限读取和提交绑定到一个会话生命周期。 */
export function createPermissionScope(options: {
  load: () => Promise<string>
  save: (value: string) => Promise<unknown>
  publish: (state: PermissionState) => void
  fail: (error: unknown) => void
}) {
  let live = true
  let state: PermissionState = { status: 'loading', value: null }
  // 生命周期失效后禁止任何迟到响应更新界面。
  const publish = (next: PermissionState): void => {
    state = next
    if (live) options.publish(next)
  }
  publish(state)
  // 加载期间禁用提交，旧 GET 不可能覆盖后续保存结果。
  void options.load().then((value) => {
    if (live) publish({ status: 'ready', value })
  }).catch((error: unknown) => {
    if (!live) return
    publish({ status: 'unavailable', value: null })
    options.fail(error)
  })
  const change = (value: string): void => {
    if (!live || state.status !== 'ready') return
    const confirmed = state.value
    publish({ status: 'saving', value: confirmed })
    // 保存成功前保留已确认权限；失败后回滚且显示错误。
    void options.save(value).then(() => {
      if (live) publish({ status: 'ready', value })
    }).catch((error: unknown) => {
      if (!live) return
      publish({ status: 'ready', value: confirmed })
      options.fail(error)
    })
  }
  return { change, dispose: () => { live = false } }
}
