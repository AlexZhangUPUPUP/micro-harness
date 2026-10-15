import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type SearchHit } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'

export interface PaletteAction {
  id: string
  label: string
  hint?: string
  run: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  actions: PaletteAction[]
  onOpenSession: (id: string) => void
}

/**
 * ⌘K palette: filters app actions and, from 2 characters on, searches every saved
 * session through the server's FTS index (`/api/search`).
 */
export function CommandPalette({ open, onClose, actions, onOpenSession }: CommandPaletteProps) {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [hits, setHits] = useState<SearchHit[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    setHits([])
    const id = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [open])

  // Debounced full-text search over saved sessions.
  useEffect(() => {
    const q = query.trim()
    if (!open || q.length < 2) {
      setHits([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      api
        .search(q)
        .then((d) => {
          if (live) setHits(d.hits ?? [])
        })
        .catch(() => {})
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [open, query])

  const filteredActions = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions
    return actions.filter((a) => a.label.toLowerCase().includes(q))
  }, [actions, query])

  const items = useMemo(
    () => [
      ...filteredActions.map((a) => ({ key: `a:${a.id}`, label: a.label, hint: a.hint ?? t('palette.commands'), run: a.run })),
      ...hits.map((h) => ({
        key: `s:${h.sessionId}:${h.agentId}`,
        label: (h.title || h.content || h.sessionId).replace(/\s+/g, ' ').trim(),
        hint: h.model ?? t('palette.sessions'),
        run: () => onOpenSession(h.sessionId),
      })),
    ],
    [filteredActions, hits, t, onOpenSession],
  )

  useEffect(() => setIndex(0), [query])

  if (!open) return null

  const choose = (i: number): void => {
    const item = items[i]
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-xl animate-fade-in overflow-hidden rounded-xl border border-border bg-popover text-foreground shadow-2xl"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(i + 1, items.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              choose(index)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            }
          }}
          placeholder={t('palette.placeholder')}
          className="w-full border-b border-border bg-transparent px-4 py-3 text-[14px] outline-none"
        />
        <div role="listbox" aria-label={t('palette.commands')} className="max-h-[50vh] overflow-y-auto py-1">
          {items.length === 0 && <div className="px-4 py-3 text-[12px] text-muted-foreground">{t('palette.noResults')}</div>}
          {items.map((it, i) => (
            <button
              key={it.key}
              role="option"
              aria-selected={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(i)}
              className={`flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] ${i === index ? 'bg-muted' : ''}`}
            >
              <span className="min-w-0 flex-1 truncate">{it.label}</span>
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{it.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
