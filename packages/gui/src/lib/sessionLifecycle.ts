import type { TaggedEvent } from './api.ts'

/** 只向当前生命周期提交异步结果，清理后忽略成功和失败回调。 */
export function loadScoped<T>(load: () => Promise<T>, accept: (value: T) => void, reject: (error: unknown) => void): () => void {
  let live = true
  // 请求结束时再次确认所属生命周期仍然有效。
  void load().then((value) => { if (live) accept(value) }).catch((error: unknown) => { if (live) reject(error) })
  // 清理仅使结果失效，不要求底层请求支持取消。
  return () => { live = false }
}

/** 按完整事件标识合并快照与加载期间的流事件。 */
function mergeEvents(base: TaggedEvent[], extra: TaggedEvent[]): TaggedEvent[] {
  const key = (event: TaggedEvent): string => `${event.agentId}:${event.seq}:${event.t}`
  const seen = new Set(base.map(key))
  const result = base.slice()
  // 同一事件可能同时出现在快照和历史重放中。
  for (const event of extra) {
    if (seen.has(key(event))) continue
    seen.add(key(event))
    result.push(event)
  }
  return result
}

type StreamHandlers = { onEvent: (event: TaggedEvent) => void; onError: () => void }
type SessionLifecycle = {
  load: () => Promise<{ events: TaggedEvent[] }>
  subscribe: (handlers: StreamHandlers) => () => void
  replace: (events: TaggedEvent[]) => void
  append: (event: TaggedEvent) => void
  receive: (event: TaggedEvent) => void
  fail: (error: unknown) => void
}

/** 隔离会话快照和订阅，切换后所有旧回调失效。 */
export function startSessionLifecycle(options: SessionLifecycle): () => void {
  let live = true
  let loaded = false
  const buffered: TaggedEvent[] = []
  // 新会话在快照返回前也不能显示上一会话的内容。
  options.replace([])
  const finish = (events: TaggedEvent[]): void => {
    loaded = true
    options.replace(mergeEvents(events, buffered))
    buffered.length = 0
  }
  // 快照失败仍允许当前流继续展示，但必须向用户报告失败。
  const cancelLoad = loadScoped(options.load, (result) => finish(result.events), (error) => {
    finish([])
    options.fail(error)
  })
  const unsubscribe = options.subscribe({
    onEvent: (event) => {
      // 关闭订阅后迟到的回调不得改变当前会话。
      if (!live) return
      options.receive(event)
      // 快照未返回时先缓冲，避免被快照覆盖。
      if (loaded) options.append(event)
      else buffered.push(event)
    },
    onError: () => { if (live) options.fail(new Error('event stream disconnected')) },
  })
  // 先使回调失效，再关闭底层连接，覆盖关闭过程中的延迟回调。
  return () => {
    live = false
    cancelLoad()
    unsubscribe()
  }
}
