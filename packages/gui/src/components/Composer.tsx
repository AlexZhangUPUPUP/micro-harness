import { useT } from '../lib/i18n.tsx'

interface ComposerProps {
  value: string
  setValue: (v: string) => void
  onSend: () => void
  busy: boolean
}

/** Floating input card with keyboard hints; gradient frame while a run is busy. */
export function Composer({ value, setValue, onSend, busy }: ComposerProps) {
  const { t } = useT()
  return (
    <div className="shrink-0 border-t border-border/70 bg-background/70 p-3 backdrop-blur">
      <div className="mx-auto w-full max-w-[760px]">
        <div className={`rounded-xl p-px transition ${busy ? 'busy-frame' : 'bg-input focus-within:bg-teal/70'}`}>
          <div className="rounded-[11px] bg-card">
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  onSend()
                }
              }}
              rows={2}
              aria-label={t('a11y.composer')}
              placeholder={t('composer.placeholder')}
              className="w-full resize-none rounded-t-[11px] bg-transparent px-3.5 py-2.5 text-[13px] leading-6 outline-none placeholder:text-muted-foreground/70"
            />
            <div className="flex items-center gap-2 border-t border-border/50 px-3 py-1.5">
              <span className="hidden items-center gap-2 text-[10px] text-muted-foreground sm:flex">
                <kbd className="rounded border border-border bg-muted/60 px-1.5 py-px font-sans">{t('composer.hintSend')}</kbd>
                <kbd className="rounded border border-border bg-muted/60 px-1.5 py-px font-sans">{t('composer.hintNewline')}</kbd>
              </span>
              {busy && (
                <span className="flex items-center gap-1.5 text-[11px] text-gold" role="status">
                  <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-gold" aria-hidden="true" />
                  {t('composer.running')}
                </span>
              )}
              <button
                onClick={onSend}
                disabled={busy || !value.trim()}
                className="ml-auto flex h-7 items-center gap-1 rounded-full bg-teal px-4 text-[12px] font-medium text-white transition hover:brightness-110 disabled:opacity-40"
              >
                {t('composer.send')}
                <span aria-hidden="true">↑</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
