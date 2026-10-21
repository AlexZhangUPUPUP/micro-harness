import { useEffect, useMemo, useState } from 'react'
import type { TaggedEvent } from '../lib/api.ts'
import { deriveUsageStats, summarizeCalls, type UsageCall } from '../lib/derive.ts'
import { fmtCost, fmtTokens } from '../lib/format.ts'
import { useT } from '../lib/i18n.tsx'

interface UsagePanelProps {
  open: boolean
  events: TaggedEvent[]
  /** Context budget from the server; 0 means unknown. */
  maxContext?: number
  onClose: () => void
}

type SeriesKey = 'newInput' | 'cacheRead' | 'output'

const SERIES: Array<{ key: SeriesKey; bar: string; legend: string; label: string }> = [
  { key: 'newInput', bar: 'fill-teal', legend: 'bg-teal', label: 'usage.newInput' },
  { key: 'cacheRead', bar: 'fill-sky-500', legend: 'bg-sky-500', label: 'usage.cachedInput' },
  { key: 'output', bar: 'fill-gold', legend: 'bg-gold', label: 'usage.output' },
]

const clock = (ms: number): string =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** Time label for an axis tick; include the date when the session crosses days. */
const axisTime = (ms: number, reference: number): string => {
  const a = new Date(ms)
  const b = new Date(reference)
  const sameDay = a.toDateString() === b.toDateString()
  return sameDay ? clock(ms) : a.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })
}

const stamp = (ms: number): string => {
  const d = new Date(ms)
  return `${d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })} ${d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })}`
}

/**
 * Token usage detail: what was spent, where it went, and which call was large.
 * Data comes from `usage` events; a call is one model request, not a user turn.
 */
export function UsagePanel({ open, events, maxContext = 0, onClose }: UsagePanelProps) {
  const { t } = useT()
  const stats = useMemo(() => deriveUsageStats(events), [events])
  const [agent, setAgent] = useState('all')
  const [model, setModel] = useState('all')
  const [view, setView] = useState<'call' | 'time'>('call')
  const [hidden, setHidden] = useState<Set<SeriesKey>>(new Set())
  const [selected, setSelected] = useState<number | null>(null)
  const [sort, setSort] = useState<'index' | 'total' | 'cost'>('index')

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const filtered = useMemo(
    () =>
      stats.calls.filter(
        (c) => (agent === 'all' || c.agentId === agent) && (model === 'all' || c.model === model),
      ),
    [stats.calls, agent, model],
  )
  const summary = useMemo(() => summarizeCalls(filtered), [filtered])
  const filteredActive = agent !== 'all' || model !== 'all'
  const ordered = useMemo(
    () => (view === 'call' ? filtered : [...filtered].sort((a, b) => a.t - b.t)),
    [filtered, view],
  )
  const rows = useMemo(() => {
    const list = [...filtered]
    if (sort === 'total') list.sort((a, b) => b.total - a.total)
    if (sort === 'cost') list.sort((a, b) => b.cost - a.cost)
    return list
  }, [filtered, sort])
  const selectedCall = filtered.find((c) => c.index === selected) ?? null

  useEffect(() => {
    if (selected != null && !filtered.some((c) => c.index === selected)) setSelected(null)
  }, [filtered, selected])

  if (!open) return null

  const visible = SERIES.filter((s) => !hidden.has(s.key))
  const W = Math.max(640, ordered.length * 10)
  const H = 168
  const L = 42
  const R = 10
  const T = 10
  const B = 22
  const slot = ordered.length ? (W - L - R) / ordered.length : W - L - R
  const barW = Math.max(3, slot * 0.62)
  const value = (c: UsageCall, key: SeriesKey): number =>
    key === 'newInput' ? Math.max(0, c.input - c.cacheRead) : c[key]
  const max = Math.max(
    1,
    ...ordered.map((c) => visible.reduce((sum, s) => sum + value(c, s.key), 0)),
  )
  const y = (v: number): number => T + (1 - v / max) * (H - T - B)
  const x = (i: number): number => L + i * slot + (slot - barW) / 2

  const totalOf = (c: UsageCall): number => visible.reduce((sum, s) => sum + value(c, s.key), 0)

  const toggle = (key: SeriesKey): void =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[7vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[86vh] w-full max-w-4xl flex-col rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
          <div>
            <h2 className="text-sm font-semibold">{t('usage.title')}</h2>
            <p className="text-[11px] text-muted-foreground">{t('usage.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('usage.close')}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {stats.calls.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground">{t('usage.empty')}</div>
          ) : (
            <>
              {/* Filters: only shown when the data actually has more than one value. */}
              {(stats.agents.length > 1 || stats.models.length > 1) && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  {stats.agents.length > 1 && (
                    <label className="flex items-center gap-1">
                      {t('usage.filterAgent')}
                      <select
                        value={agent}
                        onChange={(e) => setAgent(e.target.value)}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground"
                      >
                        <option value="all">{t('usage.allAgents')}</option>
                        {stats.agents.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {stats.models.length > 1 && (
                    <label className="flex items-center gap-1">
                      {t('usage.filterModel')}
                      <select
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px] text-foreground"
                      >
                        <option value="all">{t('usage.allModels')}</option>
                        {stats.models.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              )}

              {/* Primary metrics: cost, input, output, calls. */}
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Card
                  label={t('usage.cost')}
                  value={summary.pricing === 'none' ? t('usage.unpriced') : fmtCost(summary.cost)}
                  hint={summary.pricing === 'partial' ? t('usage.partial') : undefined}
                />
                <Card
                  label={t('usage.input')}
                  value={fmtTokens(summary.input)}
                  hint={`${t('usage.newInput')} ${fmtTokens(summary.newInput)} · ${t('usage.cachedInput')} ${fmtTokens(summary.cacheRead)}`}
                />
                <Card
                  label={t('usage.output')}
                  value={fmtTokens(summary.output)}
                  hint={summary.reasoning > 0 ? `${t('usage.reasoning')} ${fmtTokens(summary.reasoning)}` : undefined}
                />
                <Card label={t('usage.calls')} value={String(summary.count)} />
              </div>

              {/* Secondary, compact: totals and ratios, not nine equal cards. */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                <span>
                  {t('usage.total')} <b className="font-mono text-foreground">{fmtTokens(summary.total)}</b>
                </span>
                <span>
                  {t('usage.avgPerCall')} <b className="font-mono text-foreground">{fmtTokens(summary.avgPerCall)}</b>
                </span>
                <span>
                  {t('usage.peak')} <b className="font-mono text-foreground">{fmtTokens(summary.peak)}</b>
                </span>
                <span>
                  {t('usage.cacheHit')}{' '}
                  <b className="font-mono text-foreground">
                    {summary.cacheHit == null ? '—' : `${Math.round(summary.cacheHit * 100)}%`}
                  </b>
                </span>
                {summary.avgLatency != null && (
                  <span>
                    {t('usage.latency')} <b className="font-mono text-foreground">{summary.avgLatency} ms</b>
                  </span>
                )}
                {stats.contextTokens != null && maxContext > 0 && (
                  <span className="flex items-center gap-1.5">
                    {t('usage.context')}
                    <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                      <span
                        className={`block h-full ${
                          stats.contextTokens / maxContext >= 0.8 ? 'bg-destructive' : 'bg-teal'
                        }`}
                        style={{ width: `${Math.min(100, Math.round((stats.contextTokens / maxContext) * 100))}%` }}
                      />
                    </span>
                    <b className="font-mono text-foreground">
                      {fmtTokens(stats.contextTokens)} / {fmtTokens(maxContext)}
                    </b>
                    <span>({Math.min(100, Math.round((stats.contextTokens / maxContext) * 100))}%)</span>
                  </span>
                )}
                <span className="ml-auto">{filteredActive ? t('usage.filtered') : t('usage.wholeSession')}</span>
              </div>

              {/* Stacked bars, one per model call; equal width so idle gaps do not dominate. */}
              <div className="rounded-lg border border-border bg-background/50 p-2">
                <div className="flex items-center gap-2 pb-1 text-[10px] text-muted-foreground">
                  <div className="flex items-center gap-1" role="group" aria-label={t('usage.legend')}>
                    {SERIES.map((s) => (
                      <button
                        key={s.key}
                        type="button"
                        onClick={() => toggle(s.key)}
                        aria-pressed={!hidden.has(s.key)}
                        className={`flex items-center gap-1 rounded px-1 py-0.5 transition hover:bg-muted ${
                          hidden.has(s.key) ? 'line-through opacity-50' : ''
                        }`}
                      >
                        <span className={`h-1.5 w-2.5 rounded-sm ${s.legend}`} />
                        {t(s.label)}
                      </button>
                    ))}
                  </div>
                  <div className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setView('call')}
                      aria-pressed={view === 'call'}
                      className={`rounded px-1.5 py-0.5 ${view === 'call' ? 'bg-muted text-foreground' : ''}`}
                    >
                      {t('usage.byCall')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setView('time')}
                      aria-pressed={view === 'time'}
                      className={`rounded px-1.5 py-0.5 ${view === 'time' ? 'bg-muted text-foreground' : ''}`}
                    >
                      {t('usage.byTime')}
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <svg width={W} height={H} className="block" role="img" aria-label={t('usage.chart')}>
                    {[0, 0.5, 1].map((f) => (
                      <g key={f}>
                        <line
                          x1={L}
                          x2={W - R}
                          y1={y(max * f)}
                          y2={y(max * f)}
                          className="stroke-border"
                          strokeWidth={1}
                          strokeDasharray={f === 0 ? undefined : '3 4'}
                        />
                        <text x={L - 5} y={y(max * f) + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">
                          {fmtTokens(Math.round(max * f))}
                        </text>
                      </g>
                    ))}
                    {ordered.map((c, i) => {
                      let base = 0
                      const parts = visible.map((s) => {
                        const v = value(c, s.key)
                        const h = (v / max) * (H - T - B)
                        const rect = (
                          <rect
                            key={s.key}
                            x={x(i)}
                            y={y(base + v)}
                            width={barW}
                            height={Math.max(0, h)}
                            className={s.bar}
                          />
                        )
                        base += v
                        return rect
                      })
                      return (
                        <g
                          key={c.index}
                          onClick={() => setSelected(c.index)}
                          className="cursor-pointer"
                          role="button"
                          tabIndex={0}
                          aria-label={`#${c.index} ${fmtTokens(totalOf(c))}`}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') setSelected(c.index)
                          }}
                        >
                          {parts}
                          {selected === c.index && (
                            <rect
                              x={x(i) - 1}
                              y={y(totalOf(c)) - 1}
                              width={barW + 2}
                              height={(totalOf(c) / max) * (H - T - B) + 2}
                              fill="none"
                              className="stroke-foreground"
                              strokeWidth={1}
                            />
                          )}
                          <rect x={L + i * slot} y={T} width={slot} height={H - T - B} fill="transparent" />
                          <title>
                            {`#${c.index} · ${stamp(c.t)}${c.model ? ` · ${c.model}` : ''} · ${t('usage.newInput')} ${fmtTokens(value(c, 'newInput'))} · ${t('usage.cachedInput')} ${fmtTokens(c.cacheRead)} · ${t('usage.output')} ${fmtTokens(c.output)} · ${t('usage.total')} ${fmtTokens(c.total)}${
                              c.hasCost ? ` · ${fmtCost(c.cost)}` : ''
                            }${stats.agents.length > 1 ? ` · ${c.agentId}` : ''}`}
                          </title>
                        </g>
                      )
                    })}
                    {[...new Set([0, Math.floor(ordered.length / 2), ordered.length - 1])].map((idx, i, list) => {
                      const c = ordered[idx]
                      if (!c) return null
                      const first = i === 0
                      const last = i === list.length - 1
                      return (
                        <text
                          key={idx}
                          x={x(idx)}
                          y={H - 6}
                          textAnchor={first ? 'start' : last ? 'end' : 'middle'}
                          className="fill-muted-foreground text-[9px]"
                        >
                          {view === 'time' ? axisTime(c.t, ordered[0]!.t) : `#${c.index}`}
                        </text>
                      )
                    })}
                  </svg>
                </div>
              </div>

              {/* Selected call, or a hint. Message ids are not recorded in usage events. */}
              <div className="rounded-lg border border-border bg-background/40 px-3 py-2 text-[11px]">
                {selectedCall ? (
                  <div className="space-y-0.5">
                    <div className="font-mono text-foreground">
                      #{selectedCall.index} · {stamp(selectedCall.t)}
                      {selectedCall.model ? ` · ${selectedCall.model}` : ''}
                      {stats.agents.length > 1 ? ` · ${selectedCall.agentId}` : ''}
                    </div>
                    <div className="text-muted-foreground">
                      {t('usage.newInput')} {fmtTokens(Math.max(0, selectedCall.input - selectedCall.cacheRead))} ·{' '}
                      {t('usage.cachedInput')} {fmtTokens(selectedCall.cacheRead)} · {t('usage.output')}{' '}
                      {fmtTokens(selectedCall.output)} · {t('usage.total')} {fmtTokens(selectedCall.total)}
                      {selectedCall.cacheHit != null
                        ? ` · ${t('usage.cacheHit')} ${Math.round(selectedCall.cacheHit * 100)}%`
                        : ''}
                      {selectedCall.hasCost ? ` · ${fmtCost(selectedCall.cost)}` : ''}
                    </div>
                  </div>
                ) : (
                  <div className="text-muted-foreground">{t('usage.pickCall')}</div>
                )}
              </div>

              {/* Compact table, linked to the chart selection. */}
              <div className="rounded-lg border border-border">
                <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                  <span className="text-[11px] font-medium">{t('usage.table')}</span>
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => setSort('total')}
                      aria-pressed={sort === 'total'}
                      className={`rounded px-1.5 py-0.5 ${sort === 'total' ? 'bg-muted text-foreground' : ''}`}
                    >
                      {t('usage.sortTotal')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSort('cost')}
                      aria-pressed={sort === 'cost'}
                      className={`rounded px-1.5 py-0.5 ${sort === 'cost' ? 'bg-muted text-foreground' : ''}`}
                    >
                      {t('usage.sortCost')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSort('index')}
                      aria-pressed={sort === 'index'}
                      className={`rounded px-1.5 py-0.5 ${sort === 'index' ? 'bg-muted text-foreground' : ''}`}
                    >
                      {t('usage.byCall')}
                    </button>
                  </div>
                </div>
                <div className="max-h-56 overflow-auto">
                  <table className="w-full text-[10.5px]">
                    <thead className="sticky top-0 bg-card text-muted-foreground">
                      <tr>
                        <th className="px-2 py-1 text-left font-medium">#</th>
                        <th className="px-2 py-1 text-left font-medium">{t('usage.time')}</th>
                        <th className="px-2 py-1 text-left font-medium">{t('usage.model')}</th>
                        <th className="px-2 py-1 text-right font-medium">{t('usage.newInput')}</th>
                        <th className="px-2 py-1 text-right font-medium">{t('usage.cachedInput')}</th>
                        <th className="px-2 py-1 text-right font-medium">{t('usage.output')}</th>
                        <th className="px-2 py-1 text-right font-medium">{t('usage.total')}</th>
                        <th className="px-2 py-1 text-right font-medium">{t('usage.duration')}</th>
                        <th className="px-2 py-1 text-right font-medium">{t('usage.cost')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((c) => (
                        <tr
                          key={c.index}
                          tabIndex={0}
                          onClick={() => setSelected(c.index)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') setSelected(c.index)
                          }}
                          aria-selected={selected === c.index}
                          className={`cursor-pointer border-t border-border/40 ${
                            selected === c.index ? 'bg-teal/10' : 'hover:bg-muted/40'
                          }`}
                        >
                          <td className="px-2 py-0.5 font-mono">{c.index}</td>
                          <td className="px-2 py-0.5 font-mono text-muted-foreground">{clock(c.t)}</td>
                          <td className="max-w-[10rem] truncate px-2 py-0.5 font-mono" title={c.model ?? ''}>
                            {c.model ?? '—'}
                          </td>
                          <td className="px-2 py-0.5 text-right font-mono">{fmtTokens(Math.max(0, c.input - c.cacheRead))}</td>
                          <td className="px-2 py-0.5 text-right font-mono">{fmtTokens(c.cacheRead)}</td>
                          <td className="px-2 py-0.5 text-right font-mono">{fmtTokens(c.output)}</td>
                          <td className="px-2 py-0.5 text-right font-mono">{fmtTokens(c.total)}</td>
                          <td className="px-2 py-0.5 text-right font-mono text-muted-foreground">
                            {c.durationMs != null ? `${c.durationMs} ms` : '—'}
                          </td>
                          <td className="px-2 py-0.5 text-right font-mono text-muted-foreground">
                            {c.hasCost ? fmtCost(c.cost) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate font-mono text-sm text-foreground" title={value}>
        {value}
      </div>
      {hint && <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  )
}
