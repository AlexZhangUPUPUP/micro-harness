import { useRef, useState } from 'react'
import type { SessionMeta } from '../lib/api.ts'
import { groupSessions } from '../lib/derive.ts'
import { useT } from '../lib/i18n.tsx'
import { fmtCost, fmtTokens } from '../lib/format.ts'

interface SidebarProps {
  sessions: SessionMeta[]
  current: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete?: (id: string) => void
}

const statusDot = (status: string): string => {
  const s = status.toLowerCase()
  if (s.includes('run') || s.includes('active')) return 'bg-gold animate-pulse-soft'
  if (s.includes('err') || s.includes('fail')) return 'bg-destructive'
  return 'bg-teal'
}

/** Left rail: sessions grouped by day, hover to delete, keyboard-navigable. */
export function Sidebar({ sessions, current, onSelect, onNew, onDelete }: SidebarProps) {
  const { t } = useT()
  const listRef = useRef<HTMLDivElement>(null)
  const [armed, setArmed] = useState<string | null>(null)

  const groups = groupSessions(sessions)

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const items = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')
    if (!items?.length) return
    e.preventDefault()
    const idx = [...items].findIndex((el) => el === document.activeElement)
    const next = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0)
    items[next < 0 ? 0 : next].focus()
  }

  return (
    <div className="flex h-full w-full flex-col bg-card/40">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t('sessions.title', { n: sessions.length })}
        </span>
        <button
          onClick={onNew}
          className="rounded-full border border-teal/40 px-2.5 py-0.5 text-[11px] font-medium text-teal transition hover:bg-teal/10"
        >
          {t('sessions.new')}
        </button>
      </div>

      <div
        ref={listRef}
        role="listbox"
        aria-label={t('sessions.title', { n: sessions.length })}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {sessions.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <span className="h-8 w-8 rounded-xl border border-dashed border-teal/50 bg-teal/5" aria-hidden="true" />
            <p className="text-[11px] text-muted-foreground">{t('sessions.empty')}</p>
            <button
              onClick={onNew}
              className="rounded-full bg-teal px-3.5 py-1 text-[11px] font-medium text-white transition hover:brightness-110"
            >
              {t('sessions.new')}
            </button>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.key}>
            <div className="sticky top-0 z-10 -mx-2 bg-card/95 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground backdrop-blur">
              {t(`sessions.${g.key}`)}
            </div>
            {g.items.map((s) => {
              const active = s.id === current
              const isArmed = armed === s.id
              return (
                <div
                  key={s.id}
                  className={`group relative mb-1 flex items-stretch rounded-lg transition ${
                    active ? 'bg-teal/10' : 'hover:bg-muted/60'
                  }`}
                >
                  {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-teal" aria-hidden="true" />}
                  <button
                    role="option"
                    aria-selected={active}
                    onClick={() => onSelect(s.id)}
                    className="min-w-0 flex-1 rounded-lg px-3 py-2 text-left"
                  >
                    <span className="block truncate text-[12px] font-medium leading-5">{s.title || s.id.slice(0, 8)}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot(s.status)}`} aria-hidden="true" />
                      <span className="truncate">
                        {s.status} · {s.model} · {fmtTokens(s.input + s.output)} tok · {fmtCost(s.cost)}
                      </span>
                    </span>
                  </button>
                  {onDelete && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (isArmed) {
                          setArmed(null)
                          onDelete(s.id)
                        } else {
                          setArmed(s.id)
                        }
                      }}
                      title={isArmed ? t('common.cancel') : t('common.delete')}
                      className={`my-1.5 mr-1.5 grid w-7 shrink-0 place-items-center rounded-md text-[10px] transition ${
                        isArmed
                          ? 'bg-destructive/15 text-destructive'
                          : 'text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-muted hover:text-destructive'
                      }`}
                    >
                      {isArmed ? t('common.cancel').slice(0, 3) : '×'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
