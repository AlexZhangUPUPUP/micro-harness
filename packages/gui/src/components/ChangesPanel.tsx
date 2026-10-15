import { useCallback, useEffect, useState } from 'react'
import { api, type AgentWorktree, type AgentDiff, type IntegrateFile } from '../lib/api.ts'
import { useT } from '../lib/i18n.tsx'
import { DiffView } from './DiffView.tsx'

/** Worktree isolation: per-agent diffs, promote, and the merge queue. */
export function ChangesPanel({ sessionId }: { sessionId: string }) {
  const { t } = useT()
  const [agents, setAgents] = useState<AgentWorktree[]>([])
  const [diff, setDiff] = useState<AgentDiff | null>(null)
  const [plan, setPlan] = useState<IntegrateFile[] | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    api
      .agents(sessionId)
      .then(setAgents)
      .catch(() => setAgents([]))
  }, [sessionId])
  useEffect(() => reload(), [reload])

  const showDiff = async (agentId: string): Promise<void> => {
    setMsg('')
    try {
      setDiff(await api.agentDiff(sessionId, agentId))
    } catch (err) {
      setMsg(String((err as Error).message))
    }
  }

  const promote = async (agentId: string): Promise<void> => {
    setBusy(true)
    setMsg('')
    try {
      const r = await api.promoteAgent(sessionId, agentId)
      setMsg(
        r.ok
          ? t('changes.promoted', { n: r.applied.length }) +
              (r.conflicts.length ? t('changes.promotedConflicts', { n: r.conflicts.length }) : '')
          : t('changes.failed', { error: r.error ?? 'conflicts' }),
      )
      reload()
    } catch (err) {
      setMsg(String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const preview = async (): Promise<void> => {
    setBusy(true)
    setMsg('')
    try {
      setPlan((await api.integrate(sessionId)).files)
    } catch (err) {
      setMsg(String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const applyClean = async (): Promise<void> => {
    if (!plan) return
    const files = plan.filter((f) => f.clean && !f.binary && !f.skipped).map((f) => ({ path: f.path, content: f.content ?? '' }))
    setBusy(true)
    setMsg('')
    try {
      const r = await api.integrateApply(sessionId, files)
      setMsg(t('changes.integrated', { n: r.applied.length }))
      setPlan(null)
      reload()
    } catch (err) {
      setMsg(String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11px]">
        <span className="text-muted-foreground">{t('changes.title', { n: agents.length })}</span>
        <button
          onClick={preview}
          disabled={busy || !agents.length}
          className="ml-auto rounded-full border border-teal/40 px-2.5 py-0.5 font-medium text-teal transition hover:bg-teal/10 disabled:opacity-40"
        >
          {t('changes.integrateAll')}
        </button>
      </div>
      {msg && (
        <div className="border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground" role="status">
          {msg}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2 text-[12px]">
        {agents.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <span className="h-8 w-8 rounded-lg border border-dashed border-border" aria-hidden="true" />
            <p className="text-[11px] leading-5 text-muted-foreground">{t('changes.empty')}</p>
          </div>
        )}
        {agents.map((a) => (
          <div
            key={a.agentId}
            className="mb-1.5 flex items-center gap-2 rounded-lg border border-border bg-card/70 px-2.5 py-1.5 transition hover:border-teal/40"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal" aria-hidden="true" />
            <span className="shrink-0 font-mono font-medium">{a.agentId.split('/').pop()}</span>
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" title={a.branch}>
              {a.branch}
            </span>
            <button
              onClick={() => void showDiff(a.agentId)}
              className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              {t('changes.diff')}
            </button>
            <button
              onClick={() => void promote(a.agentId)}
              disabled={busy}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-teal transition hover:bg-teal/10 disabled:opacity-40"
            >
              {t('changes.promote')}
            </button>
          </div>
        ))}
        {diff && (
          <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card/70">
            <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-2.5 py-1.5 text-[11px]">
              <span className="font-mono font-medium">{diff.agentId}</span>
              <span className="text-muted-foreground">{t('changes.files', { n: diff.files.length })}</span>
              <button onClick={() => setDiff(null)} className="ml-auto rounded px-1 text-muted-foreground hover:text-foreground">
                {t('changes.close')}
              </button>
            </div>
            <div className="border-b border-border/50">
              {diff.files.map((f) => (
                <div key={f.path} className="flex items-center gap-2 px-2.5 py-1 font-mono text-[10px]">
                  <span className="w-4 shrink-0 rounded bg-muted text-center text-[9px] text-muted-foreground">{f.status}</span>
                  <span className="min-w-0 flex-1 truncate">{f.path}</span>
                  {f.add > 0 && <span className="shrink-0 text-teal">+{f.add}</span>}
                  {f.del > 0 && <span className="shrink-0 text-destructive">-{f.del}</span>}
                </div>
              ))}
            </div>
            <DiffView text={diff.diff.slice(0, 100000)} className="max-h-72" />
          </div>
        )}
        {plan && (
          <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card/70">
            <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-2.5 py-1.5 text-[11px]">
              <span>{t('changes.queue', { n: plan.length })}</span>
              <button
                onClick={() => void applyClean()}
                disabled={busy}
                className="ml-auto rounded-md px-1.5 py-0.5 font-medium text-teal transition hover:bg-teal/10 disabled:opacity-40"
              >
                {t('changes.applyClean')}
              </button>
              <button onClick={() => setPlan(null)} className="rounded px-1 text-muted-foreground hover:text-foreground">
                {t('changes.close')}
              </button>
            </div>
            {plan.map((f) => (
              <div key={f.path} className="flex items-center gap-2 border-b border-border/40 px-2.5 py-1 font-mono text-[10px]">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${f.clean ? 'bg-teal' : 'bg-destructive'}`} aria-hidden="true" />
                <span className={f.clean ? 'text-teal' : 'text-destructive'}>
                  {f.clean ? t('changes.clean') : t('changes.conflict')}
                </span>
                <span className="min-w-0 truncate">{f.path}</span>
                {f.pending.length > 0 && (
                  <span className="ml-auto shrink-0 text-muted-foreground">{t('changes.pending', { n: f.pending.length })}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
