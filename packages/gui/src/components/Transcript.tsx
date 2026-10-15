import { useState } from 'react'
import type { ChatItem } from '../lib/derive.ts'
import { useT } from '../lib/i18n.tsx'
import Markdown from './Markdown.tsx'
import { fmtTime } from '../lib/format.ts'

/** The conversation stream: user bubbles, assistant blocks, tool timeline, notices. */
export function Transcript({ items }: { items: ChatItem[] }) {
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
        <TranscriptItem key={item.id} item={item} />
      ))}
    </div>
  )
}

function TranscriptItem({ item }: { item: ChatItem }) {
  if (item.kind === 'user') return <UserBubble item={item} />
  if (item.kind === 'notice') return <Notice item={item} />
  if (item.kind === 'tool') return <ToolCard item={item} />
  return <AssistantBlock item={item} />
}

function UserBubble({ item }: { item: Extract<ChatItem, { kind: 'user' }> }) {
  return (
    <div className="flex justify-end animate-rise">
      <div className="max-w-[70%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-gradient-to-br from-teal to-teal/80 px-3.5 py-2 text-[13px] leading-relaxed text-white shadow-[0_2px_12px_hsl(var(--teal)/0.35)]">
        {item.text}
      </div>
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
