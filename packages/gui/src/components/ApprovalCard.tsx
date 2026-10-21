import { useState } from 'react'
import type { PendingApproval } from '../lib/approvals.ts'
import { useT } from '../lib/i18n.tsx'
import { approvalDiff } from '../lib/approvalDiff.ts'

type Phase = 'pending' | 'sending' | 'resolved'

/**
 * One pending tool-call approval: tool name, pretty-printed args, agent id and
 * Allow/Deny. While the answer is in flight the buttons collapse to `…`; once
 * answered the card shows the resolved verdict and becomes non-interactive.
 */
export function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: PendingApproval
  onDecide?: (id: string, allow: boolean) => void | Promise<void>
}) {
  const { t } = useT()
  const [phase, setPhase] = useState<Phase>('pending')
  const [decision, setDecision] = useState<boolean | null>(null)

  const busy = phase === 'sending'
  const resolved = phase === 'resolved'

  const decide = (allow: boolean): void => {
    if (busy || resolved) return
    setPhase('sending')
    setDecision(allow)
    void Promise.resolve(onDecide?.(approval.id, allow)).then(
      () => setPhase('resolved'),
      () => {
        setPhase('pending')
        setDecision(null)
      },
    )
  }

  const argsJson = approval.args === undefined ? '{}' : JSON.stringify(approval.args, null, 2)
  const diff = approvalDiff(approval.tool, approval.args, approval.preview?.before)
  const verdict = resolved ? (decision ? t('approval.allowed') : t('approval.denied')) : t('approval.title')

  return (
    <div className="flex animate-rise gap-3 pl-1">
      {/* timeline rail, matching ToolCard */}
      <div className="flex w-3 shrink-0 flex-col items-center pt-[7px]" aria-hidden="true">
        <span
          className={`h-2 w-2 rounded-full ${
            resolved ? (decision ? 'bg-teal' : 'bg-destructive') : 'animate-pulse-soft bg-gold'
          }`}
        />
        <span className="mt-1 w-px flex-1 bg-border" />
      </div>

      <div
        className={`min-w-0 flex-1 rounded-lg border px-3 py-2 backdrop-blur transition ${
          resolved
            ? decision
              ? 'border-teal/40 bg-teal/5'
              : 'border-destructive/40 bg-destructive/5'
            : 'border-border/70 bg-card/70'
        }`}
      >
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <span
            aria-hidden="true"
            className={resolved ? (decision ? 'text-teal' : 'text-destructive') : 'text-gold'}
          >
            {resolved ? (decision ? '✓' : '✗') : busy ? '…' : '?'}
          </span>
          <span className="font-semibold">{approval.tool}</span>
          {approval.sandbox && (
            <span className="rounded-full border border-teal/40 bg-teal/10 px-1.5 py-px text-[10px] text-teal">
              {t('approval.sandbox', { kind: approval.sandbox })}
            </span>
          )}
          <span className="ml-auto shrink-0 truncate text-muted-foreground">{approval.agentId}</span>
        </div>

        <p
          className={`mt-0.5 text-[11px] font-medium ${
            resolved ? (decision ? 'text-teal' : 'text-destructive') : 'text-gold'
          }`}
        >
          {verdict}
        </p>

        <div className="mt-1.5">
          <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {diff ? t('approval.diff') : t('approval.arguments')}
          </div>
          {diff ? (
            <>
              <pre className="max-h-48 overflow-auto rounded-md border border-border/50 bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">
                {diff.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.kind === 'add'
                        ? 'bg-teal/10 text-teal'
                        : line.kind === 'del'
                          ? 'bg-destructive/10 text-destructive'
                          : 'text-muted-foreground'
                    }
                  >
                    {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
                    {line.text || ' '}
                  </div>
                ))}
              </pre>
              <details className="mt-1">
                <summary className="cursor-pointer text-[10px] text-muted-foreground">{t('approval.raw')}</summary>
                <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/30 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {argsJson}
                </pre>
              </details>
            </>
          ) : (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {argsJson}
            </pre>
          )}
        </div>

        {!resolved && (
          <div className="mt-2 flex items-center gap-1.5">
            <button
              onClick={() => decide(true)}
              disabled={busy}
              className="rounded-md bg-teal px-2.5 py-1 text-[11px] font-medium text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? '…' : t('approval.allow')}
            </button>
            <button
              onClick={() => decide(false)}
              disabled={busy}
              className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition hover:border-destructive/50 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? '…' : t('approval.deny')}
            </button>
            {busy && <span className="ml-1 text-[11px] text-muted-foreground">{t('approval.waiting')}</span>}
          </div>
        )}
      </div>
    </div>
  )
}
