import { useEffect, useMemo } from 'react'
import type { TaggedEvent } from '../lib/api.ts'
import { deriveUsageStats } from '../lib/derive.ts'
import { fmtCost, fmtTokens } from '../lib/format.ts'
import { useT } from '../lib/i18n.tsx'

interface UsagePanelProps {
  open: boolean
  events: TaggedEvent[]
  onClose: () => void
}

/** Click the header's token pill to see per-turn usage and the totals. */
export function UsagePanel({ open, events, onClose }: UsagePanelProps) {
  const { t } = useT()
  const stats = useMemo(() => deriveUsageStats(events), [events])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const { points } = stats
  const max = Math.max(1, ...points.flatMap((p) => [Math.max(0, p.input - p.cacheRead), p.cacheRead, p.output]))
  const W = 640
  const H = 200
  const L = 46
  const R = 12
  const T = 14
  const B = 26
  const t0 = points[0]?.t ?? 0
  const t1 = points[points.length - 1]?.t ?? t0
  const span = t1 - t0
  const px = (t: number): number => (span <= 0 ? (L + W - R) / 2 : L + ((t - t0) / span) * (W - L - R))
  const py = (v: number): number => T + (1 - v / max) * (H - T - B)
  const series = [
    { key: 'newInput' as const, color: 'stroke-teal', dot: 'fill-teal', legend: 'bg-teal', label: t('usage.newInput') },
    { key: 'cacheRead' as const, color: 'stroke-sky-500', dot: 'fill-sky-500', legend: 'bg-sky-500', label: t('usage.cachedInput') },
    { key: 'output' as const, color: 'stroke-gold', dot: 'fill-gold', legend: 'bg-gold', label: t('usage.output') },
  ]
  const value = (p: (typeof points)[number], key: 'newInput' | 'cacheRead' | 'output'): number =>
    key === 'newInput' ? Math.max(0, p.input - p.cacheRead) : p[key]
  const time = (ms: number): string =>
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

  const ticks = span > 0 ? [t0, t0 + span / 2, t1] : [t0]

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-full max-w-3xl rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
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

        <div className="space-y-4 p-4">
          {points.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground">{t('usage.empty')}</div>
          ) : (
            <>
              <div className="rounded-lg border border-border bg-background/50 p-3">
                <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={t('usage.title')}>
                  {[0, 0.5, 1].map((f) => (
                    <g key={f}>
                      <line
                        x1={L}
                        x2={W - R}
                        y1={py(max * f)}
                        y2={py(max * f)}
                        className="stroke-border"
                        strokeWidth={1}
                        strokeDasharray={f === 0 ? undefined : '3 4'}
                      />
                      <text x={L - 6} y={py(max * f) + 3} textAnchor="end" className="fill-muted-foreground text-[9px]">
                        {fmtTokens(Math.round(max * f))}
                      </text>
                    </g>
                  ))}
                  {series.map((s) => (
                    <polyline
                      key={s.key}
                      points={points.map((p) => `${px(p.t).toFixed(1)},${py(value(p, s.key)).toFixed(1)}`).join(' ')}
                      fill="none"
                      className={s.color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  ))}
                  {series.map((s) =>
                    points.map((p, i) => (
                      <circle key={`${s.key}-${i}`} cx={px(p.t)} cy={py(value(p, s.key))} r={2.2} className={s.dot}>
                        <title>
                          {`${time(p.t)} · ${t('usage.newInput')} ${fmtTokens(value(p, 'newInput'))} · ${t('usage.cachedInput')} ${fmtTokens(p.cacheRead)} · ${t('usage.output')} ${fmtTokens(p.output)}`}
                        </title>
                      </circle>
                    )),
                  )}
                  {ticks.map((tick, i) => (
                    <text
                      key={tick}
                      x={px(tick)}
                      y={H - 8}
                      textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
                      className="fill-muted-foreground text-[9px]"
                    >
                      {time(tick)}
                    </text>
                  ))}
                </svg>
                <div className="mt-2 flex flex-wrap items-center gap-4 text-[10px] text-muted-foreground">
                  {series.map((s) => (
                    <span key={s.key} className="flex items-center gap-1">
                      <span className={`h-1.5 w-3 rounded-full ${s.legend}`} />
                      {s.label}
                    </span>
                  ))}
                  <span className="ml-auto">
                    {t('usage.turns')}: {stats.turns}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label={t('usage.total')} value={fmtTokens(stats.input + stats.output)} />
                <Stat label={t('usage.newInput')} value={fmtTokens(stats.newInput)} />
                <Stat label={t('usage.cachedInput')} value={fmtTokens(stats.cacheRead)} />
                <Stat label={t('usage.output')} value={fmtTokens(stats.output)} />
                <Stat
                  label={t('usage.cacheHit')}
                  value={stats.cacheHit == null ? '—' : `${Math.round(stats.cacheHit * 100)}%`}
                />
                <Stat label={t('usage.cost')} value={stats.priced ? fmtCost(stats.cost) : '—'} />
                <Stat label={t('usage.turns')} value={String(stats.turns)} />
                <Stat label={t('usage.avg')} value={fmtTokens(stats.avgPerTurn)} />
                <Stat label={t('usage.peak')} value={fmtTokens(stats.peak)} />
              </div>

              {!stats.priced && (
                <p className="text-[11px] text-muted-foreground">{t('usage.unpricedHint')}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-sm">{value}</div>
    </div>
  )
}
