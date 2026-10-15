import { useState } from 'react'
import { useT } from '../lib/i18n.tsx'
import { PermissionPicker } from './PermissionPicker.tsx'
import type { ImageInput } from '../lib/api.ts'

interface ComposerProps {
  value: string
  setValue: (v: string) => void
  onSend: () => void
  busy: boolean
  models?: string[]
  model?: string
  setModel?: (m: string) => void
  /** Attached images, as base64 — pasted or dropped onto the textarea. */
  images?: ImageInput[]
  setImages?: (next: ImageInput[]) => void
  /** Current permission preset and its setter (switching `full` asks first). */
  permission?: string
  onPermission?: (id: string) => void
}

/** Floating input card with keyboard hints; gradient frame while a run is busy. */
export function Composer({ value, setValue, onSend, busy, models, model, setModel, images = [], setImages, permission, onPermission }: ComposerProps) {
  const [dragging, setDragging] = useState(false)

  /** Files → base64 (no data-URL prefix), the shape the server and provider want. */
  const addFiles = (files: FileList | null | undefined): void => {
    if (!files?.length || !setImages) return
    const picked = [...files].filter((f) => f.type.startsWith('image/'))
    if (!picked.length) return
    void Promise.all(
      picked.map(
        (f) =>
          new Promise<ImageInput | null>((resolve) => {
            const reader = new FileReader()
            reader.onload = () => {
              const url = String(reader.result ?? '')
              const comma = url.indexOf(',')
              resolve(comma === -1 ? null : { mimeType: f.type, data: url.slice(comma + 1) })
            }
            reader.onerror = () => resolve(null)
            reader.readAsDataURL(f)
          }),
      ),
    ).then((loaded) => setImages([...images, ...loaded.filter((x): x is ImageInput => x !== null)]))
  }
  const { t } = useT()
  return (
    <div className="shrink-0 border-t border-border/70 bg-background/70 p-3 backdrop-blur">
      <div className="mx-auto w-full max-w-[760px]">
        <div className={`rounded-xl p-px transition ${busy ? 'busy-frame' : 'bg-input focus-within:bg-teal/70'}`}>
          <div className="rounded-[11px] bg-card">
            {(images.length > 0 || dragging) && (
              <div className="flex flex-wrap items-center gap-1.5 px-3 pt-2">
                {images.map((img, i) => (
                  <span
                    key={`${img.mimeType}-${i}`}
                    className="flex items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    <img src={`data:${img.mimeType};base64,${img.data}`} alt="" className="h-5 w-5 rounded object-cover" />
                    {img.mimeType.replace('image/', '')}
                    <button
                      onClick={() => setImages?.(images.filter((_, j) => j !== i))}
                      aria-label={t('composer.removeImage')}
                      className="ml-0.5 text-muted-foreground hover:text-destructive"
                    >
                      ×
                    </button>
                  </span>
                ))}
                {dragging && <span className="text-[10px] text-teal">{t('composer.dropImage')}</span>}
              </div>
            )}
            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onPaste={(e) => {
                const files = e.clipboardData?.files
                if (files?.length) {
                  e.preventDefault()
                  addFiles(files)
                }
              }}
              onDragOver={(e) => {
                if (e.dataTransfer?.types.includes('Files')) {
                  e.preventDefault()
                  setDragging(true)
                }
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                if (e.dataTransfer?.files?.length) {
                  e.preventDefault()
                  setDragging(false)
                  addFiles(e.dataTransfer.files)
                }
              }}
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
              {onPermission && <PermissionPicker value={permission ?? 'full'} onChange={onPermission} />}
              {models && models.length > 1 && (
                <select
                  value={model}
                  onChange={(e) => setModel?.(e.target.value)}
                  aria-label={t('composer.model')}
                  className="rounded border border-border bg-transparent px-1.5 py-px font-mono text-[10px] text-muted-foreground outline-none focus:border-teal/50"
                >
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
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
