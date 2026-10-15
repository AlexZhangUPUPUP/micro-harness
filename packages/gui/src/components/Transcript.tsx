import { useRef, useState } from 'react'
import type { ChatItem } from '../lib/derive.ts'
import { useT } from '../lib/i18n.tsx'
import Markdown from './Markdown.tsx'
import { fmtTime } from '../lib/format.ts'

/** The conversation stream: user bubbles, assistant blocks, tool timeline, notices. */
export function Transcript({
  items,
  onEditResend,
}: {
  items: ChatItem[]
  onEditResend?: (at: number, text: string) => void
}) {
  const { t } = useT()
  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <span className="relative flex h-10 w-10 items-center justify-center" aria-hidden="true">
          <span className="absolute inset-0 rounded-2xl border border-teal/40 bg-teal/5" />
          <span className="h-2 w-2 animate-pulse-soft rounded-full bg-teal shadow-[0_0_12px_hsl(var(--teal)/0.9)]" />
        </span>
        <p className="text-[12px] text-muted-foreground">{t('chat.empty')}</p>
      </div>
    )
  }
  return (
    <div role="log" aria-live="polite" aria-label={t('a11y.transcript')} className="stagger mx-auto w-full max-w-[760px] space-y-3">
      {items.map((item) => (
        <TranscriptItem key={item.id} item={item} onEditResend={onEditResend} />
      ))}
    </div>
  )
}

function TranscriptItem({ item, onEditResend }: { item: ChatItem; onEditResend?: (at: number, text: string) => void }) {
  if (item.kind === 'user') return <UserBubble item={item} onEditResend={onEditResend} />
  if (item.kind === 'notice') return <Notice item={item} />
  if (item.kind === 'tool') return <ToolCard item={item} />
  return <AssistantBlock item={item} />
}

function UserBubble({
  item,
  onEditResend,
}: {
  item: Extract<ChatItem, { kind: 'user' }>
  onEditResend?: (at: number, text: string) => void
}) {
  const { t } = useT()
  const [editing, setEditing] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)

  const save = () => {
    const text = ref.current?.value.trim() ?? ''
    if (text) onEditResend?.(item.at, text)
  }

  if (editing) {
    return (
      <div className="flex animate-rise justify-end">
        <div className="flex w-full max-w-[70%] flex-col gap-1.5">
          <textarea
            ref={ref}
            autoFocus
            defaultValue={item.text}
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false)
              else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                save()
              }
            }}
            className="w-full resize-none rounded-2xl rounded-br-md border border-border/60 bg-input px-3.5 py-2 text-[13px] leading-relaxed outline-none focus:border-teal/50"
          />
          <div className="flex justify-end gap-1.5">
            <button
              onClick={() => setEditing(false)}
              className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={save}
              className="rounded-md bg-teal px-2.5 py-1 text-[11px] font-medium text-white transition hover:brightness-110"
            >
              {t('chat.save')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="group flex animate-rise justify-end">
      <div className="max-w-[70%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-gradient-to-br from-teal to-teal/80 px-3.5 py-2 text-[13px] leading-relaxed text-white shadow-[0_2px_12px_hsl(var(--teal)/0.35)]">
        {item.text}
      </div>
      {onEditResend && (
        <button
          onClick={() => setEditing(true)}
          title={t('chat.editTitle')}
          className="ml-1 shrink-0 self-center rounded px-1 text-[10px] text-muted-foreground opacity-0 transition hover:text-teal group-hover:opacity-100"
        >
          {t('chat.edit')}
        </button>
      )}
    </div>
  )
}

function Notice({ item }: { item: Extract<ChatItem, { kind: 'notice' }> }) {
  const error = item.level === 'error'
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={`animate-rise rounded-lg border px-3 py-2 text-[12px] ${
        error ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-muted/40 text-muted-foreground'
      }`}
    >
      {item.text}
    </div>
  )
}

function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const running = item.ok === undefined && item.output === undefined
  const failed = item.ok === false
  const outputId = `${item.id}-output`

  return (
    <div className="flex animate-rise gap-3 pl-1">
      {/* timeline rail */}
      <div className="flex w-3 shrink-0 flex-col items-center pt-[7px]" aria-hidden="true">
        <span
          className={`h-2 w-2 rounded-full ${
            failed ? 'bg-destructive' : running ? 'animate-pulse-soft bg-gold' : 'bg-teal'
          }`}
        />
        <span className="mt-1 w-px flex-1 bg-border" />
      </div>

      <div className="min-w-0 flex-1 rounded-lg border border-border/70 bg-card/70 px-3 py-1.5 backdrop-blur transition hover:border-teal/40">
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <span className={failed ? 'text-destructive' : running ? 'text-gold' : 'text-teal'} aria-hidden="true">
            {failed ? '✗' : running ? '◌' : '✓'}
          </span>
          <span className="font-semibold">{item.name}</span>
          <span className="min-w-0 truncate text-muted-foreground">
            {item.args ? JSON.stringify(item.args).slice(0, 80) : ''}
          </span>
          {running && <span className="ml-auto shrink-0 text-gold">{t('tool.running')}</span>}
          {!running && item.ms != null && (
            <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
              {item.ms}ms
            </span>
          )}
          {item.output && (
            <button
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              aria-controls={outputId}
              className={`shrink-0 rounded px-1 text-[10px] text-teal hover:underline ${running || item.ms == null ? 'ml-auto' : ''}`}
            >
              {open ? t('tool.hideOutput') : t('tool.showOutput')}
            </button>
          )}
        </div>
        {item.output && open && (
          <pre
            id={outputId}
            className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground"
          >
            {item.output.slice(0, 2000)}
          </pre>
        )}
      </div>
    </div>
  )
}

function AssistantBlock({ item }: { item: Extract<ChatItem, { kind: 'assistant' }> }) {
  const { t } = useT()
  const child = item.agentId !== 'main'

  const caret = item.streaming && (
    <span className="ml-1 inline-block h-[13px] w-[7px] translate-y-[2px] animate-caret rounded-[2px] bg-teal" aria-hidden="true" />
  )
  const meta = (
    <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
      <span>{fmtTime(item.t)}</span>
      {item.streaming && <span className="text-teal">{t('chat.streaming')}</span>}
    </div>
  )

  if (child) {
    return (
      <div className="ml-8 animate-rise rounded-xl border border-teal/30 bg-teal/5 px-3.5 py-2.5 backdrop-blur">
        <div className="mb-1 font-mono text-[10px] font-medium text-teal">⎇ {item.agentId}</div>
        <Markdown text={item.text} className="text-[13px] leading-6" />
        {caret}
        {meta}
      </div>
    )
  }

  return (
    <div className="animate-rise border-l-2 border-teal/40 pl-4">
      <Markdown text={item.text} className="text-[13.5px] leading-7" />
      {caret}
      {meta}
    </div>
  )
}
