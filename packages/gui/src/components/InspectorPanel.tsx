import { useEffect, useState } from 'react'
import { messagePreview, type ModelRequest, type RequestMessage } from '../lib/derive.ts'
import { useT } from '../lib/i18n.tsx'
import { fmtTokens } from '../lib/format.ts'

interface InspectorPanelProps {
  requests: ModelRequest[]
}

/** Colour a message role with the panel's existing vocabulary. */
const roleBadge = (role: string): string => {
  if (role === 'tool') return 'border-teal/40 bg-teal/10 text-teal'
  if (role === 'user') return 'border-border text-foreground'
  if (role === 'system') return 'border-gold/40 bg-gold/10 text-gold'
  if (role === 'assistant') return 'border-border bg-muted/40 text-muted-foreground'
  if (role === 'error' || role.includes('error')) return 'border-destructive/40 bg-destructive/10 text-destructive'
  return 'border-border bg-muted/40 text-muted-foreground'
}

const caret = (open: boolean): string => (open ? '▾' : '▸')

/** Right-hand "Inspector": exactly what was handed to the model, request by request. */
export function InspectorPanel({ requests }: InspectorPanelProps) {
  const { t } = useT()
  // `null` means "follow the latest"; a number is an explicit pin the user picked.
  const [selected, setSelected] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)

  // Follow new requests, but only when the count changes — a pin the user chose
  // survives plain re-renders in between.
  useEffect(() => {
    setSelected(null)
    setExpanded(null)
  }, [requests.length])

  const latest = requests.length - 1
  const idx = requests.length > 0 ? (selected == null ? latest : Math.min(selected, latest)) : -1
  const req = idx >= 0 ? requests[idx] : undefined

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2 text-[11px]">
        <span className="font-mono text-muted-foreground">{t('inspector.title', { n: requests.length })}</span>
      </div>

      {requests.length > 0 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
          {requests.map((r, i) => {
            const isLast = i === latest
            const isSel = i === idx
            return (
              <button
                key={`${r.agentId}-${r.t}-${i}`}
                onClick={() => setSelected(i)}
                aria-pressed={isSel}
                className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] transition ${
                  isSel ? 'border-teal/50 bg-teal/10 text-teal' : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('inspector.request', { n: i + 1 })}
                {isLast && <span className="ml-1 text-muted-foreground/70">{t('inspector.latest')}</span>}
              </button>
            )
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[10px]">
        {requests.length === 0 && <div className="px-3 py-6 text-center text-muted-foreground">{t('inspector.empty')}</div>}
        {req && (
          <div className="p-2">
            <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5 text-[10px] text-muted-foreground">
              <span className="font-medium text-foreground">{req.model || '—'}</span>
              <span>{t('inspector.tokens', { n: fmtTokens(req.tokens) })}</span>
              <span className="min-w-0 truncate" title={req.agentId}>
                {req.agentId}
              </span>
            </div>

            <SystemSection text={req.system} />

            <div className="mb-1.5 overflow-hidden rounded-lg border border-border bg-card/70">
              <div className="px-2.5 py-1.5 text-[10px] font-medium text-foreground">
                {t('inspector.tools', { n: req.tools.length })}
              </div>
              <div className="px-2.5 pb-2">
                {req.tools.length === 0 ? (
                  <span className="text-muted-foreground/70">—</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {req.tools.map((name, i) => (
                      <span key={i} className="rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                        {name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="mb-1.5 overflow-hidden rounded-lg border border-border bg-card/70">
              <div className="border-b border-border/50 px-2.5 py-1.5 text-[10px] font-medium text-foreground">
                {t('inspector.messages', { n: req.messages.length })}
              </div>
              {req.messages.map((m, i) => (
                <MessageRow key={i} m={m} open={expanded === i} onToggle={() => setExpanded(expanded === i ? null : i)} />
              ))}
            </div>

            <button
              onClick={() => void navigator.clipboard?.writeText(JSON.stringify(req, null, 2))}
              className="rounded-full border border-teal/40 px-2.5 py-0.5 font-mono text-[10px] font-medium text-teal transition hover:bg-teal/10"
            >
              {t('inspector.copyJson')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function SystemSection({ text }: { text: string }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const preview = text.replace(/\s+/g, ' ').trim()
  return (
    <div className="mb-1.5 overflow-hidden rounded-lg border border-border bg-card/70">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition hover:bg-muted/40"
      >
        <span className="shrink-0 text-[10px] font-medium text-foreground">{t('inspector.system')}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/80">{preview || '—'}</span>
        <span className="shrink-0 text-[9px] text-muted-foreground" aria-hidden="true">
          {caret(open)}
        </span>
      </button>
      {open && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-border/50 px-2.5 py-2 text-[10px] leading-relaxed text-foreground/90">
          {text}
        </pre>
      )}
    </div>
  )
}

function MessageRow({ m, open, onToggle }: { m: RequestMessage; open: boolean; onToggle: () => void }) {
  const preview = messagePreview(m)
  return (
    <div className="border-b border-border/40 last:border-b-0">
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition hover:bg-muted/40"
      >
        <span className={`shrink-0 rounded border px-1 py-px text-[9px] font-medium ${roleBadge(m.role)}`}>
          {m.role || 'msg'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{preview || '(empty)'}</span>
        <span className="shrink-0 text-[9px] text-muted-foreground" aria-hidden="true">
          {caret(open)}
        </span>
      </button>
      {open && (
        <div className="px-2.5 pb-2">
          {m.content != null && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/40 p-2 text-[10px] leading-relaxed text-foreground/90">
              {String(m.content)}
            </pre>
          )}
          {m.tool_calls !== undefined && <PrettyJson label="tool_calls" value={m.tool_calls} />}
          {m.tool_call_id !== undefined && <PrettyJson label="tool_call_id" value={m.tool_call_id} />}
        </div>
      )}
    </div>
  )
}

function PrettyJson({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="mt-1.5">
      <div className="mb-0.5 text-[9px] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/40 p-2 text-[10px] leading-relaxed text-gold/90">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}
