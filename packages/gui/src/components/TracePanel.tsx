import { useMemo, useState } from 'react'
import type { TaggedEvent } from '../lib/api.ts'
import { filterTrace, traceCategory, type TraceCategory } from '../lib/derive.ts'
import { useT } from '../lib/i18n.tsx'
import { fmtTime } from '../lib/format.ts'

interface TracePanelProps {
  events: TaggedEvent[]
  replayAt: number | null
  setReplayAt: (n: number | null) => void
}

const CATEGORIES: TraceCategory[] = ['all', 'text', 'tool', 'usage', 'error']

const typeColor = (type: string): string => {
  if (type === 'error') return 'text-destructive'
  if (type.startsWith('tool')) return 'text-teal'
  if (type === 'usage') return 'text-gold'
  if (type.startsWith('text')) return 'text-foreground'
  return 'text-muted-foreground'
}

/** Raw event stream with category filters, search and a replay scrubber. */
export function TracePanel({ events, replayAt, setReplayAt }: TracePanelProps) {
  const { t } = useT()
  const [category, setCategory] = useState<TraceCategory>('all')
  const [q, setQ] = useState('')
  const at = replayAt ?? events.length

  const shown = useMemo(() => filterTrace(events.slice(0, at), { category, q }), [events, at, category, q])

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="font-mono text-muted-foreground">{t('trace.title', { at, total: events.length })}</span>
          <button
            onClick={() => setReplayAt(replayAt == null ? events.length : null)}
            className={`rounded-full border px-2.5 py-0.5 font-medium transition ${
              replayAt == null
                ? 'border-teal/40 text-teal hover:bg-teal/10'
                : 'border-gold/50 bg-gold/10 text-gold hover:bg-gold/20'
            }`}
          >
            {replayAt == null ? t('trace.replay') : t('trace.live')}
          </button>
        </div>
        <input
          type="range"
          min={0}
          max={events.length}
          value={at}
          onChange={(e) => setReplayAt(Number(e.target.value))}
          aria-label={t('trace.scrubber')}
          className="scrubber mt-2.5 w-full"
        />
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`rounded-full border px-2 py-0.5 text-[10px] transition ${
                category === c ? 'border-teal/50 bg-teal/10 text-teal' : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(`trace.${c}`)}
            </button>
          ))}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('trace.search')}
            className="ml-auto w-32 rounded border border-border bg-background/60 px-1.5 py-0.5 text-[10px] outline-none focus:border-teal/50"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[10px]">
        {events.length === 0 && <div className="px-3 py-6 text-center text-muted-foreground">{t('trace.empty')}</div>}
        {events.length > 0 && shown.length === 0 && (
          <div className="px-3 py-6 text-center text-muted-foreground">{t('palette.noResults')}</div>
        )}
        {shown.map((e, i) => (
          <div
            key={`${e.agentId}-${e.seq}-${i}`}
            className={`flex items-center gap-2 border-b border-border/40 px-2 py-1 ${i % 2 ? 'bg-muted/20' : ''}`}
          >
            <span className="w-8 shrink-0 text-muted-foreground/70">{e.seq}</span>
            <span className={`w-16 shrink-0 truncate ${traceCategory(e.event.type) === 'tool' ? 'text-teal/80' : 'text-muted-foreground/70'}`}>
              {e.agentId.split('/').pop()}
            </span>
            <span className={`shrink-0 ${typeColor(e.event.type)}`}>{e.event.type}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{summarize(e)}</span>
            <span className="shrink-0 text-muted-foreground/70">{fmtTime(e.t)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function summarize(e: TaggedEvent): string {
  const ev = e.event as Record<string, unknown>
  if (ev.type === 'tool.call' && typeof ev.sandbox === 'string') return `${ev.name} · ${ev.sandbox}`
  for (const key of ['text', 'message', 'name', 'content', 'output', 'stopReason', 'reason', 'model']) {
    if (typeof ev[key] === 'string') return String(ev[key]).replace(/\n/g, ' ').slice(0, 80)
  }
  return ''
}
