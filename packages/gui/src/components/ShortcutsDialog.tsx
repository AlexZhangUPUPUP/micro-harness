import { useEffect } from 'react'
import { useT } from '../lib/i18n.tsx'

interface ShortcutsDialogProps {
  open: boolean
  onClose: () => void
}

const KEYS: Array<{ keys: string; label: string }> = [
  { keys: '⌘ K', label: 'shortcuts.palette' },
  { keys: '⌘ /', label: 'shortcuts.help' },
  { keys: '↑ ↓', label: 'shortcuts.nav' },
  { keys: 'Enter', label: 'shortcuts.send' },
  { keys: '⇧ Enter', label: 'shortcuts.newline' },
  { keys: 'Esc', label: 'shortcuts.close' },
]

/** ⌘/ — the keyboard cheat sheet. */
export function ShortcutsDialog({ open, onClose }: ShortcutsDialogProps) {
  const { t } = useT()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[18vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcuts.title')}
        className="w-full max-w-sm animate-fade-in overflow-hidden rounded-xl border border-border bg-popover p-4 text-foreground shadow-2xl"
      >
        <div className="mb-3 text-[12px] font-semibold">{t('shortcuts.title')}</div>
        <div className="space-y-2">
          {KEYS.map((k) => (
            <div key={k.keys} className="flex items-center justify-between gap-4">
              <span className="text-[12px] text-muted-foreground">{t(k.label)}</span>
              <kbd className="shrink-0 rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px]">
                {k.keys}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
