import { useEffect, useRef, useState } from 'react'
import { useT } from '../lib/i18n.tsx'

/**
 * Permission presets, mirroring `PERMISSIONS` on the server. `full` and
 * `auto-review` widen access to the shell (and therefore the network), so
 * choosing them asks for confirmation first — with real buttons, inline.
 */
const PRESETS = [
  { id: 'read-only', exp: false },
  { id: 'workspace', exp: false },
  { id: 'full', exp: false },
  { id: 'auto-review', exp: true },
] as const

function ShieldIcon({ active }: { active?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`mt-px h-3.5 w-3.5 shrink-0 ${active ? 'text-teal' : 'text-muted-foreground'}`}
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
}

export function PermissionPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (): void => {
      setOpen(false)
      setPending(null)
    }
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const label = (id: string): string => t(`perm.${id}`)
  const risky = (id: string): boolean => id === 'full' || id === 'auto-review'

  const choose = (id: string): void => {
    if (id === value) {
      setOpen(false)
      setPending(null)
      return
    }
    if (risky(id)) {
      setPending(id)
      return
    }
    onChange(id)
    setOpen(false)
    setPending(null)
  }

  const confirm = (): void => {
    if (pending) onChange(pending)
    setPending(null)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v)
          setPending(null)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('perm.title')}
        className="flex items-center gap-1 rounded border border-border bg-transparent px-1.5 py-px font-mono text-[10px] text-muted-foreground outline-none transition hover:border-teal/50 hover:text-foreground"
      >
        <ShieldIcon />
        <span>{label(value)}</span>
        <span aria-hidden="true" className="opacity-60">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-50 mb-1 w-64 rounded-lg border border-border bg-popover p-1 text-foreground shadow-xl"
        >
          {!pending ? (
            <>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                {t('perm.title')}
              </div>
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  role="menuitemradio"
                  aria-checked={p.id === value}
                  onClick={() => choose(p.id)}
                  className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition hover:bg-muted ${
                    p.id === value ? 'bg-teal/10' : ''
                  }`}
                >
                  <ShieldIcon active={p.id === value} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[12px] font-medium">
                      {label(p.id)}
                      {p.exp && <span className="rounded bg-gold/20 px-1 text-[9px] text-gold">EXP</span>}
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                      {t(`perm.note.${p.id}`)}
                    </span>
                  </span>
                  {p.id === value && <span className="shrink-0 text-teal">✓</span>}
                </button>
              ))}
            </>
          ) : (
            <div className="p-2">
              <div className="text-[12px] font-medium">{t('perm.confirm', { name: label(pending) })}</div>
              <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
                {t(`perm.note.${pending}`)}
              </div>
              <div className="mt-2 flex justify-end gap-1.5">
                <button
                  onClick={() => setPending(null)}
                  className="rounded-md border border-border px-2.5 py-1 text-[11px] transition hover:bg-muted"
                >
                  {t('perm.cancel')}
                </button>
                <button
                  onClick={confirm}
                  className="rounded-md bg-gold px-2.5 py-1 text-[11px] font-medium text-black transition hover:brightness-110"
                >
                  {t('perm.confirmCta')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
