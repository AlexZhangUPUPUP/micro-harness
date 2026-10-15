import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type SessionMeta, type TaggedEvent, type AgentWorktree, type AgentDiff, type IntegrateFile } from './lib/api.ts'
import { deriveAgents, deriveChat, truncate, type AgentNode, type ChatItem } from './lib/derive.ts'

const fmtTokens = (n: number): string => (n < 1000 ? String(n) : n < 1_000_000 ? (n / 1000).toFixed(1) + 'k' : (n / 1e6).toFixed(1) + 'M')
const fmtCost = (n: number): string => (n ? '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(3)) : '$0')
const fmtTime = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [events, setEvents] = useState<TaggedEvent[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<'chat' | 'trace' | 'changes'>('chat')
  const [replayAt, setReplayAt] = useState<number | null>(null)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const [runTick, setRunTick] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.list()
      setSessions(list)
      // Auto-open the newest session so the app is never a blank page.
      setCurrent((cur) => cur ?? list[0]?.id ?? null)
    } catch (err) {
      setError(String((err as Error).message))
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
    const t = setInterval(() => void refreshSessions(), 5000)
    return () => clearInterval(t)
  }, [refreshSessions])

  // Load + subscribe to the selected session. `runTick` re-subscribes after a
  // follow-up, because the server closes the stream when each run finishes.
  useEffect(() => {
    if (!current) return
    let live = true
    void api.get(current).then((d) => {
      if (live) setEvents(d.events)
    })
    const off = api.subscribe(current, {
      onEvent: (e) => {
        setError('')
        setEvents((prev) => (prev.some((x) => x.seq === e.seq && x.agentId === e.agentId) ? prev : [...prev, e]))
      },
      onError: () => setError('event stream disconnected'),
    })
    return () => {
      live = false
      off()
    }
  }, [current, runTick])

  const shown = useMemo(() => (replayAt == null ? events : truncate(events, replayAt)), [events, replayAt])
  const chat = useMemo(() => deriveChat(shown), [shown])
  const tree = useMemo(() => deriveAgents(shown), [shown])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [chat.length, chat[chat.length - 1]?.kind])

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || busy) return
    setBusy(true)
    setError('')
    setInput('')
    try {
      if (current) {
        await api.resume(current, text)
        setRunTick((t) => t + 1)
      } else {
        const meta = await api.create(text)
        setCurrent(meta.id)
      }
      void refreshSessions()
    } catch (err) {
      setError(String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const toggleTheme = (): void => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('micro-theme', next ? 'dark' : 'light')
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-3 py-2 text-sm">
        <span className="font-semibold">micro-harness</span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{current ?? 'no session'}</span>
        <div className="ml-auto flex items-center gap-2">
          {(['chat', 'trace', 'changes'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded px-2 py-0.5 text-[11px] ${view === v ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
            >
              {v}
            </button>
          ))}
          <button onClick={toggleTheme} className="rounded px-2 py-0.5 text-[11px] text-muted-foreground">
            {dark ? '☀' : '☾'}
          </button>
        </div>
      </header>

      {error && <div className="border-b border-border bg-destructive/10 px-3 py-1 text-[11px] text-destructive">{error}</div>}

      <div className="flex min-h-0 flex-1">
        <Sidebar sessions={sessions} current={current} onSelect={(id) => { setCurrent(id); setReplayAt(null) }} onNew={() => { setCurrent(null); setEvents([]) }} />

        <main className="flex min-w-0 flex-1 flex-col">
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <Transcript items={chat} />
          </div>
          <Composer value={input} setValue={setInput} onSend={send} busy={busy} />
        </main>

        <aside className="w-[320px] shrink-0 border-l border-border">
          {view === 'chat' ? (
            <AgentsPanel roots={tree.roots} total={tree.total} />
          ) : view === 'trace' ? (
            <TracePanel events={events} replayAt={replayAt} setReplayAt={setReplayAt} />
          ) : current ? (
            <ChangesPanel sessionId={current} />
          ) : null}
        </aside>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- sidebar */

function Sidebar({
  sessions,
  current,
  onSelect,
  onNew,
}: {
  sessions: SessionMeta[]
  current: string | null
  onSelect: (id: string) => void
  onNew: () => void
}) {
  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
        <span>sessions · {sessions.length}</span>
        <button onClick={onNew} className="rounded px-1.5 hover:bg-muted">
          + new
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`block w-full border-b border-border/60 px-3 py-2 text-left text-[12px] ${s.id === current ? 'bg-muted' : 'hover:bg-muted/40'}`}
          >
            <div className="truncate">{s.title || s.id.slice(0, 8)}</div>
            <div className="font-mono text-[10px] text-muted-foreground">
              {s.status} · {s.model} · {fmtTokens(s.input + s.output)} tok · {fmtCost(s.cost)}
            </div>
          </button>
        ))}
        {sessions.length === 0 && <div className="px-3 py-4 text-[11px] text-muted-foreground">no sessions yet</div>}
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------ transcript */

function Transcript({ items }: { items: ChatItem[] }) {
  if (items.length === 0) return <div className="pt-10 text-center text-[12px] text-muted-foreground">Send a task to start.</div>
  return (
    <div className="space-y-2">
      {items.map((item) => (
        <TranscriptItem key={item.id} item={item} />
      ))}
    </div>
  )
}

function TranscriptItem({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[70%] whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-[13px] text-primary-foreground">{item.text}</div>
      </div>
    )
  }
  if (item.kind === 'notice') {
    return <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">{item.text}</div>
  }
  if (item.kind === 'tool') {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-[12px]">
        <div className="flex items-center gap-2 font-mono text-[11px]">
          <span className={item.ok === false ? 'text-destructive' : 'text-teal'}>{item.ok === false ? '✗' : '✓'}</span>
          <span className="font-semibold">{item.name}</span>
          <span className="truncate text-muted-foreground">{item.args ? JSON.stringify(item.args).slice(0, 80) : ''}</span>
          {item.ms != null && <span className="ml-auto text-muted-foreground">{item.ms}ms</span>}
        </div>
        {item.output && (
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
            {item.output.slice(0, 2000)}
          </pre>
        )}
      </div>
    )
  }
  const child = item.agentId !== 'main'
  return (
    <div className={`max-w-[85%] rounded-lg border px-3 py-2 text-[13px] ${child ? 'border-teal/30 bg-teal/5' : 'border-border bg-card'}`}>
      {child && <div className="mb-1 font-mono text-[10px] text-teal">{item.agentId}</div>}
      <div className="whitespace-pre-wrap">{item.text || (item.streaming ? '…' : '')}</div>
    </div>
  )
}

/* ---------------------------------------------------------------- composer */

function Composer({ value, setValue, onSend, busy }: { value: string; setValue: (v: string) => void; onSend: () => void; busy: boolean }) {
  return (
    <div className="border-t border-border p-3">
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
        placeholder="Ask the agent…  Enter sends · Shift+Enter newline"
        className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-[13px] outline-none"
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">{busy ? 'running…' : ''}</span>
        <button
          onClick={onSend}
          disabled={busy || !value.trim()}
          className="ml-auto rounded-md bg-primary px-3 py-1 text-[12px] text-primary-foreground disabled:opacity-40"
        >
          send
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------- agent tree */

function AgentsPanel({ roots, total }: { roots: AgentNode[]; total: { input: number; output: number; cost: number } }) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
        agents · {fmtTokens(total.input + total.output)} tok · {fmtCost(total.cost)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {roots.length === 0 && <div className="p-2 text-[11px] text-muted-foreground">no agents yet</div>}
        {roots.map((n) => (
          <AgentRow key={n.agentId} node={n} />
        ))}
      </div>
    </div>
  )
}

function AgentRow({ node }: { node: AgentNode }) {
  const label = node.agentId === 'main' ? 'main' : node.agentId.split('/').pop() || node.agentId
  return (
    <div>
      <div className="rounded border border-border bg-card px-2 py-1.5 text-[12px]" style={{ marginLeft: node.depth * 12 }}>
        <div className="flex items-center gap-2">
          <span className={node.status === 'error' ? 'text-destructive' : node.status === 'active' ? 'text-gold' : 'text-teal'}>●</span>
          <span className="font-mono">{label}</span>
          {node.worktree && (
            <span className="rounded border border-teal/40 px-1 text-[9px] text-teal" title={node.worktree.branch}>
              wt
            </span>
          )}
          <span className="ml-auto font-mono text-[10px] text-muted-foreground">
            {fmtTokens(node.input + node.output)} tok{node.cost ? ' · ' + fmtCost(node.cost) : ''}
          </span>
        </div>
        {node.tools > 0 && (
          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
            {node.tools} tool{node.tools > 1 ? 's' : ''}
            {node.errors ? ` · ${node.errors} err` : ''}
          </div>
        )}
      </div>
      {node.children.map((c) => (
        <AgentRow key={c.agentId} node={c} />
      ))}
    </div>
  )
}

/* ------------------------------------------------------------ trace/replay */

function TracePanel({
  events,
  replayAt,
  setReplayAt,
}: {
  events: TaggedEvent[]
  replayAt: number | null
  setReplayAt: (n: number | null) => void
}) {
  const at = replayAt ?? events.length
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-3 py-2 text-[11px]">
        <div className="flex justify-between text-muted-foreground">
          <span>
            trace · {at}/{events.length}
          </span>
          <button onClick={() => setReplayAt(replayAt == null ? events.length : null)} className="hover:underline">
            {replayAt == null ? 'replay' : 'live'}
          </button>
        </div>
        <input
          type="range"
          min={0}
          max={events.length}
          value={at}
          onChange={(e) => setReplayAt(Number(e.target.value))}
          className="mt-1 w-full"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto font-mono text-[10px]">
        {events.slice(0, at).map((e, i) => (
          <div key={`${e.agentId}-${e.seq}-${i}`} className={`flex gap-2 border-b border-border/50 px-2 py-0.5 ${i >= at ? 'opacity-30' : ''}`}>
            <span className="w-8 shrink-0 text-muted-foreground">{e.seq}</span>
            <span className="w-20 shrink-0 truncate text-teal">{e.agentId}</span>
            <span className="shrink-0">{e.event.type}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{summarize(e)}</span>
            <span className="shrink-0 text-muted-foreground">{fmtTime(e.t)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function summarize(e: TaggedEvent): string {
  const ev = e.event as Record<string, unknown>
  for (const key of ['text', 'message', 'name', 'content', 'output', 'stopReason', 'reason', 'model']) {
    if (typeof ev[key] === 'string') return String(ev[key]).replace(/\n/g, ' ').slice(0, 80)
  }
  return ''
}

/* ------------------------------------------------- isolation / merge queue */

function ChangesPanel({ sessionId }: { sessionId: string }) {
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
          ? `promoted ${r.applied.length} file(s)${r.conflicts.length ? ` · ${r.conflicts.length} conflict(s)` : ''}`
          : `promote failed: ${r.error ?? 'conflicts'}`,
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
      setMsg(`integrated ${r.applied.length} file(s)`)
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
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11px] text-muted-foreground">
        <span>changes · {agents.length} isolated agent(s)</span>
        <button onClick={preview} disabled={busy || !agents.length} className="ml-auto rounded px-1.5 hover:bg-muted disabled:opacity-40">
          integrate all
        </button>
      </div>
      {msg && <div className="border-b border-border px-3 py-1 text-[11px] text-muted-foreground">{msg}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto p-2 text-[12px]">
        {agents.length === 0 && (
          <div className="p-2 text-[11px] text-muted-foreground">
            No isolated agents. Start the server with <span className="font-mono">MICRO_ISOLATE=1</span> and ask the agent to use the{' '}
            <span className="font-mono">task</span> tool.
          </div>
        )}
        {agents.map((a) => (
          <div key={a.agentId} className="mb-1 flex items-center gap-2 rounded border border-border bg-card px-2 py-1">
            <span className="font-mono">{a.agentId.split('/').pop()}</span>
            <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground" title={a.branch}>
              {a.branch}
            </span>
            <button onClick={() => void showDiff(a.agentId)} className="ml-auto rounded px-1.5 hover:bg-muted">
              diff
            </button>
            <button onClick={() => void promote(a.agentId)} disabled={busy} className="rounded px-1.5 text-teal hover:bg-muted disabled:opacity-40">
              promote
            </button>
          </div>
        ))}
        {diff && (
          <div className="mt-2 overflow-hidden rounded border border-border">
            <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-[11px]">
              <span className="font-mono">{diff.agentId}</span>
              <span className="text-muted-foreground">{diff.files.length} file(s)</span>
              <button onClick={() => setDiff(null)} className="ml-auto hover:underline">
                close
              </button>
            </div>
            <div className="whitespace-pre-wrap px-2 py-1 font-mono text-[10px] text-muted-foreground">
              {diff.files.map((f) => `${f.status} ${f.path} +${f.add} -${f.del}`).join('\n')}
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-2 py-1 font-mono text-[10px]">
              {diff.diff.slice(0, 20000)}
            </pre>
          </div>
        )}
        {plan && (
          <div className="mt-2 overflow-hidden rounded border border-border">
            <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-[11px]">
              <span>merge queue · {plan.length} file(s)</span>
              <button onClick={() => void applyClean()} disabled={busy} className="ml-auto rounded px-1.5 text-teal hover:bg-muted disabled:opacity-40">
                apply clean
              </button>
              <button onClick={() => setPlan(null)} className="hover:underline">
                close
              </button>
            </div>
            {plan.map((f) => (
              <div key={f.path} className="flex items-center gap-2 border-b border-border/50 px-2 py-0.5 font-mono text-[10px]">
                <span className={f.clean ? 'text-teal' : 'text-destructive'}>{f.clean ? 'clean' : 'conflict'}</span>
                <span className="min-w-0 truncate">{f.path}</span>
                {f.pending.length > 0 && <span className="ml-auto text-muted-foreground">{f.pending.length} pending</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
