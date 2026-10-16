import { useRef, useState } from 'react'
import { useT } from '../lib/i18n.tsx'
import { PermissionPicker } from './PermissionPicker.tsx'
import type { FileAttachment, ImageInput } from '../lib/api.ts'

interface ComposerProps {
  value: string
  setValue: (v: string) => void
  onSend: () => void
  busy: boolean
  models?: string[]
  model?: string
  setModel?: (m: string) => void
  /** Attached images, as base64 — pasted or dropped onto the composer. */
  images?: ImageInput[]
  setImages?: (next: ImageInput[]) => void
  /** Non-image files, read as text and handed to the agent with the prompt. */
  files?: FileAttachment[]
  setFiles?: (next: FileAttachment[]) => void
  /** Current permission preset and its setter (switching `full` asks first). */
  permission?: string
  onPermission?: (id: string) => void
}

/** Largest text file we inline; bigger ones are truncated with a note. */
const MAX_FILE_BYTES = 256 * 1024

function UploadIcon() {
  return (
    <span className="grid h-10 w-10 place-items-center rounded-full bg-teal text-white shadow-sm" aria-hidden="true">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 16V4" />
        <path d="m7 9 5-5 5 5" />
        <path d="M20 15v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3" />
      </svg>
    </span>
  )
}

function Paperclip() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

/** Floating input card: drop zone, attachments, permission + model, send. */
export function Composer({
  value,
  setValue,
  onSend,
  busy,
  models,
  model,
  setModel,
  images = [],
  setImages,
  files = [],
  setFiles,
  permission,
  onPermission,
}: ComposerProps) {
  const { t } = useT()
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  /** Images → base64 parts (no data-URL prefix), the shape the provider wants. */
  const readImages = (list: File[]): void => {
    if (!list.length || !setImages) return
    void Promise.all(
      list.map(
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

  /** Everything else → text the agent reads. Truncated past MAX_FILE_BYTES. */
  const readTexts = (list: File[]): void => {
    if (!list.length || !setFiles) return
    void Promise.all(
      list.map(
        (f) =>
          new Promise<FileAttachment>((resolve) => {
            const reader = new FileReader()
            reader.onload = () => {
              let text = String(reader.result ?? '')
              if (f.size > MAX_FILE_BYTES) {
                text = text.slice(0, MAX_FILE_BYTES) + `\n…(truncated: file is ${f.size} bytes)`
              }
              resolve({ name: f.name, size: f.size, text })
            }
            reader.onerror = () => resolve({ name: f.name, size: f.size, text: '(could not read file)' })
            reader.readAsText(f)
          }),
      ),
    ).then((loaded) => setFiles([...files, ...loaded]))
  }

  const addFiles = (list: FileList | File[] | null | undefined): void => {
    const all = list ? [...list] : []
    if (!all.length) return
    readImages(all.filter((f) => f.type.startsWith('image/')))
    readTexts(all.filter((f) => !f.type.startsWith('image/')))
  }

  const hasAttachments = images.length > 0 || files.length > 0

  return (
    <div className="shrink-0 border-t border-border/70 bg-background/70 p-3 backdrop-blur">
      <div className="mx-auto w-full max-w-[760px]">
        <div className={`rounded-xl p-px transition ${busy ? 'busy-frame' : 'bg-input focus-within:bg-teal/70'}`}>
          <div
            className="relative rounded-[11px] bg-card"
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
          >
            {/* Drop zone: appears while files are held over the composer. */}
            {dragging && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-1.5 rounded-[11px] border-2 border-dashed border-teal/60 bg-card/95 px-4 text-center">
                <UploadIcon />
                <div className="text-[13px] font-medium">{t('composer.dropFiles')}</div>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="text-[12px] font-medium text-teal hover:underline"
                >
                  {t('composer.orClick')}
                </button>
                <div className="text-[10px] text-muted-foreground">{t('composer.fileHint')}</div>
              </div>
            )}

            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = ''
              }}
            />

            {hasAttachments && (
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
                {files.map((f, i) => (
                  <span
                    key={`${f.name}-${i}`}
                    className="flex items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    <Paperclip />
                    <span className="max-w-[160px] truncate">{f.name}</span>
                    <span className="opacity-60">{Math.max(1, Math.round(f.size / 1024))}k</span>
                    <button
                      onClick={() => setFiles?.(files.filter((_, j) => j !== i))}
                      aria-label={t('composer.removeImage')}
                      className="ml-0.5 text-muted-foreground hover:text-destructive"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            <textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onPaste={(e) => {
                const dt = e.clipboardData
                if (!dt) return
                if (dt.files?.length) {
                  e.preventDefault()
                  addFiles(dt.files)
                  return
                }
                // Some sources only put an image in the text flavours (a data URL
                // or a `{data, mimeType}` JSON); attach it instead of pasting the
                // base64 as the prompt.
                const html = dt.getData('text/html') || ''
                const text = dt.getData('text/plain') || ''
                const m =
                  /data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)/i.exec(html) ??
                  /data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)/i.exec(text)
                let data: string | null = null
                let mime: string | null = null
                if (m) {
                  mime = m[1] ?? null
                  data = (m[2] ?? '').replace(/\s+/g, '')
                } else {
                  try {
                    const j = JSON.parse(text) as { data?: unknown; mimeType?: unknown }
                    if (typeof j.data === 'string' && typeof j.mimeType === 'string' && j.mimeType.startsWith('image/')) {
                      mime = j.mimeType
                      data = j.data.replace(/\s+/g, '')
                    }
                  } catch {
                    /* ordinary text paste */
                  }
                }
                if (data && mime) {
                  e.preventDefault()
                  setImages?.([...images, { mimeType: mime, data }])
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
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                title={t('composer.attach')}
                aria-label={t('composer.attach')}
                className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <Paperclip />
              </button>
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
