import { useCallback, useEffect, useState } from 'react'
import { api, type ArtifactRecord } from '../lib/api.ts'

/** 展示会话产物，并提供可追溯的下载和删除入口。 */
export function ArtifactsPanel({ sessionId }: { sessionId: string | null }) {
  const [items, setItems] = useState<ArtifactRecord[]>([])
  const [error, setError] = useState('')
  const refresh = useCallback(() => {
    if (!sessionId) return Promise.resolve()
    return api.artifacts(sessionId).then(setItems).catch((err: unknown) => setError(String((err as Error).message)))
  }, [sessionId])
  useEffect(() => { setError(''); void refresh() }, [refresh])
  const remove = (id: string): void => {
    if (!sessionId) return
    void api.deleteArtifact(sessionId, id).then(() => void refresh()).catch((err: unknown) => setError(String((err as Error).message)))
  }
  if (!sessionId) return <div className="p-3 text-xs text-muted-foreground">请选择会话</div>
  return <section className="h-full overflow-y-auto p-3 text-xs" aria-label="会话产物">
    <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">产物</h2><button type="button" className="text-teal hover:underline" onClick={() => void refresh()}>刷新</button></div>
    {error && <p role="alert" className="mb-2 text-destructive">{error}</p>}
    {!items.length ? <p className="text-muted-foreground">暂无产物</p> : <ul className="space-y-2">{items.map((item) => <li key={item.id} className="rounded-md border border-border/70 p-2">
      <div className="flex items-center gap-2"><a className="min-w-0 flex-1 truncate text-teal hover:underline" href={api.artifactUrl(sessionId, item.id)} target="_blank" rel="noreferrer">{item.name}</a><button type="button" className="text-destructive hover:underline" onClick={() => remove(item.id)}>删除</button></div>
      <div className="mt-1 text-[10px] text-muted-foreground">{item.mime} · {item.size} bytes · {item.sha256.slice(0, 12)}</div>
    </li>)}</ul>}
  </section>
}
