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
  const max = Math.max(1, ...points.map((p) => Math.max(p.input, p.output)))
  const W = 640
  const H = 190
  const L = 46
  const R = 12
  const T = 12
  const B = 22
  const px = (i: number): number =>
    points.length <= 1 ? (L + W - R) / 2 : L + (i / (points.length - 1)) * (W - L - R)
  const py = (v: number): number => T + (1 - v / max) * (H - T - B)
  const poly = (key: 'input' | 'output'): string =>
    points.map((p, i) => `${px(i).toFixed(1)},${py(p[key]).toFixed(1)}`).join(' ')

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
                  <polyline
                    points={poly('input')}
                    fill="none"
                    className="stroke-teal"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  <polyline
                    points={poly('output')}
                    fill="none"
                    className="stroke-gold"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                  {points.map((p, i) => (
                    <g key={p.t}>
                      <circle cx={px(i)} cy={py(p.input)} r={2.5} className="fill-teal" />
                      <circle cx={px(i)} cy={py(p.output)} r={2.5} className="fill-gold" />
                    </g>
                  ))}
                  <text x={L} y={H - 6} className="fill-muted-foreground text-[9px]">
                    1
                  </text>
                  <text x={W - R} y={H - 6} textAnchor="end" className="fill-muted-foreground text-[9px]">
                    {points.length}
                  </text>
                </svg>
                <div className="mt-2 flex items-center gap-4 text-[10px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <span className="h-1.5 w-3 rounded-full bg-teal" />
                    {t('usage.input')}
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="h-1.5 w-3 rounded-full bg-gold" />
                    {t('usage.output')}
                  </span>
                  <span className="ml-auto">
                    {t('usage.turns')}: {stats.turns}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label={t('usage.total')} value={fmtTokens(stats.input + stats.output)} />
                <Stat label={t('usage.input')} value={fmtTokens(stats.input)} />
                <Stat label={t('usage.output')} value={fmtTokens(stats.output)} />
                <Stat label={t('usage.cacheRead')} value={fmtTokens(stats.cacheRead)} />
                <Stat
                  label={t('usage.cacheHit')}
                  value={stats.cacheHit == null ? '—' : `${Math.round(stats.cacheHit * 100)}%`}
                />
                <Stat label={t('usage.cost')} value={fmtCost(stats.cost)} />
                <Stat label={t('usage.turns')} value={String(stats.turns)} />
                <Stat label={t('usage.avg')} value={fmtTokens(stats.avgPerTurn)} />
                <Stat label={t('usage.peak')} value={fmtTokens(stats.peak)} />
              </div>
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
