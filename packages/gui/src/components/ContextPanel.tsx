import { useEffect, useMemo, useState } from 'react'
import { api, type ContextEvent } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { fmtTokens } from '../lib/format.ts'

type ContextPayload = { type: string; snapshotId?: string; compactionId?: string; trigger?: string; tokens?: number; budget?: number; messages?: unknown[]; sources?: Record<string, number>; reason?: string; strategy?: string; beforeTokens?: number; afterTokens?: number; dropped?: number; summarized?: number; beforeMessages?: unknown[]; afterMessages?: unknown[]; fallback?: boolean }

/** 展示单个 session 的实时上下文快照、压缩节点和前后窗口。 */
export function ContextPanel({ events, sessionId }: { events: ContextEvent[]; sessionId: string | null }) {
  const { t } = useT()
  const [selected, setSelected] = useState(0)
  const [following, setFollowing] = useState(true)
  const latest = events.length - 1
  useEffect(() => { if (following) setSelected(Math.max(0, latest)) }, [events.length, following, latest])
  const item = events[selected]
  const payload = item?.event as ContextPayload | undefined
  const latestSnapshot = useMemo(() => [...events].reverse().find((entry) => entry.event.type === 'context.snapshot'), [events])
  const summary = latestSnapshot?.event as ContextPayload | undefined

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2 text-[11px]">
        <span className="font-mono text-muted-foreground">{t('context.title', { n: events.length })}</span>
        <div className="flex items-center gap-1">
          {sessionId && <a className="rounded border border-border px-1.5 py-0.5 text-[10px] text-teal hover:bg-teal/10" href={api.contextExportUrl(sessionId)} download>{t('context.export')}</a>}
          <button className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setFollowing((value) => !value)}>{following ? t('context.pause') : t('context.follow')}</button>
        </div>
      </div>
      {summary && <ContextSummary payload={summary} />}
      {events.length === 0 ? <div className="px-3 py-6 text-center text-muted-foreground">{t('context.empty')}</div> : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
            {events.map((entry, index) => <button key={`${entry.agentId}:${entry.seq}`} onClick={() => { setFollowing(false); setSelected(index) }} className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] ${index === selected ? 'border-teal/50 bg-teal/10 text-teal' : 'border-border text-muted-foreground'}`}>{entry.event.type === 'context.compaction' ? t('context.compaction') : t('context.snapshot')} {index + 1}</button>)}
          </div>
          {item && payload && <ContextDetail payload={payload} />}
        </div>
      )}
    </div>
  )
}

/** 显示当前最新快照的占用和来源分布。 */
function ContextSummary({ payload }: { payload: ContextPayload }) {
  const { t } = useT()
  const ratio = payload.budget ? Math.min(100, Math.round(((payload.tokens ?? 0) / payload.budget) * 100)) : 0
  return <div className="border-b border-border px-3 py-2 text-[10px]"><div className="flex justify-between text-muted-foreground"><span>{t('context.current')}</span><span>{fmtTokens(payload.tokens ?? 0)} / {fmtTokens(payload.budget ?? 0)} · {ratio}%</span></div><div className="mt-1 h-1 overflow-hidden rounded bg-muted"><div className={`h-full ${ratio >= 80 ? 'bg-destructive' : 'bg-teal'}`} style={{ width: `${ratio}%` }} /></div></div>
}

/** 展开选中快照或压缩记录，保留原始 JSON 便于调试。 */
function ContextDetail({ payload }: { payload: ContextPayload }) {
  const { t } = useT()
  const isCompaction = payload.type === 'context.compaction'
  const messages = isCompaction ? payload.afterMessages : payload.messages
  return <div className="space-y-2 p-2 font-mono text-[10px]"><div className="rounded-lg border border-border bg-card/70 p-2 text-muted-foreground">{isCompaction ? <><b className="text-foreground">{t('context.compaction')}</b> · {payload.strategy} · {fmtTokens(payload.beforeTokens ?? 0)} → {fmtTokens(payload.afterTokens ?? 0)}<br />{t('context.removed', { n: payload.dropped ?? 0 })} · {t('context.summarized', { n: payload.summarized ?? 0 })} · {payload.reason}</> : <><b className="text-foreground">{t('context.snapshot')}</b> · {payload.trigger} · {fmtTokens(payload.tokens ?? 0)} / {fmtTokens(payload.budget ?? 0)}<br />{Object.entries(payload.sources ?? {}).map(([name, count]) => `${name}: ${count}`).join(' · ')}</>}</div>{isCompaction && <><div className="text-[10px] font-medium text-destructive">{t('context.before')}</div><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-destructive/30 bg-destructive/5 p-2 leading-relaxed text-foreground/90">{JSON.stringify(payload.beforeMessages ?? [], null, 2)}</pre><div className="text-[10px] font-medium text-teal">{t('context.after')}</div></>}<pre className="max-h-[calc(100vh-260px)] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-2 leading-relaxed text-foreground/90">{JSON.stringify(messages ?? [], null, 2)}</pre></div>
}
