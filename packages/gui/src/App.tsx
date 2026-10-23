import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type CommandInfo, type FileAttachment, type ImageInput, type SessionMeta, type SkillInfo, type TaggedEvent, type WebProvider } from './lib/api.ts'
import { useT } from './lib/i18n.tsx'
import { deriveAgents, deriveChat, deriveInspector, deriveTask, deriveUsageSeries, deriveUsageStats, IncrementalTaskProjector, toMarkdown, truncate, withOptimistic } from './lib/derive.ts'
import { pendingApprovals, decidePermission } from './lib/approvals.ts'
import { Header } from './components/Header.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Transcript } from './components/Transcript.tsx'
import { Composer } from './components/Composer.tsx'
import { AgentsPanel } from './components/AgentsPanel.tsx'
import { TracePanel } from './components/TracePanel.tsx'
import { ChangesPanel } from './components/ChangesPanel.tsx'
import { InspectorPanel } from './components/InspectorPanel.tsx'
import { TaskPanel } from './components/TaskPanel.tsx'
import { ArtifactsPanel } from './components/ArtifactsPanel.tsx'
import { CommandPalette, type PaletteAction } from './components/CommandPalette.tsx'
import { ShortcutsDialog } from './components/ShortcutsDialog.tsx'
import { UsagePanel } from './components/UsagePanel.tsx'
import { loadScoped, startSessionLifecycle } from './lib/sessionLifecycle.ts'
import { createPermissionScope, type PermissionState } from './lib/permissionState.ts'

type View = 'chat' | 'task' | 'trace' | 'changes' | 'artifacts' | 'inspector'
const VIEWS: View[] = ['chat', 'task', 'trace', 'changes', 'artifacts', 'inspector']
const NEW_KEY = '__new__'

/** Thin draggable divider between a side column and the main area. */
function Divider({ onResize }: { onResize: (e: React.PointerEvent) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onResize}
      className="group relative z-10 -mx-1 w-2 shrink-0 cursor-col-resize touch-none select-none"
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition group-hover:bg-teal/70" />
    </div>
  )
}

export default function App() {
  const { t, lang, setLang } = useT()
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [events, setEvents] = useState<TaggedEvent[]>([])
  const taskProjector = useRef(new IncrementalTaskProjector())
  const [input, setInput] = useState('')
  const [images, setImages] = useState<ImageInput[]>([])
  // Non-image files, read as text and sent with the prompt.
  const [files, setFiles] = useState<FileAttachment[]>([])
  const [pending, setPending] = useState<Record<string, boolean>>({})
  // Locally echoed user messages, shown before the server's `user.message` event
  // arrives so sending feels instant.
  const [optimistic, setOptimistic] = useState<Array<{ id: string; text: string; sent: string; t: number }>>([])
  const [error, setError] = useState('')
  const [view, setView] = useState<View>('chat')
  const [replayAt, setReplayAt] = useState<number | null>(null)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const [runTick, setRunTick] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [models, setModels] = useState<string[]>([])
  // 权限初始状态未知，禁止使用猜测的权限值。
  const [permission, setPermission] = useState<PermissionState & { session: string | null }>({ status: 'loading', value: null, session: null })
  const permissionScope = useRef<ReturnType<typeof createPermissionScope> | null>(null)
  const [webEnabled, setWebEnabled] = useState(true)
  const [budget, setBudget] = useState<number | null>(null)
  const [sandbox, setSandbox] = useState<{ mode: string; kind: string } | null>(null)
  const [maxContext, setMaxContext] = useState(0)
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [webProviders, setWebProviders] = useState<WebProvider[]>([])
  const [webProvider, setWebProvider] = useState('')
  const [model, setModel] = useState(() => localStorage.getItem('micro-model') ?? '')
  const [showSidebar, setShowSidebar] = useState(() => {
    const saved = localStorage.getItem('micro-sidebar')
    return saved === null ? window.matchMedia('(min-width: 768px)').matches : saved === '1'
  })
  const [showPanel, setShowPanel] = useState(() => {
    const saved = localStorage.getItem('micro-panel')
    return saved === null ? window.matchMedia('(min-width: 1024px)').matches : saved === '1'
  })
  const [leftW, setLeftW] = useState(() => Number(localStorage.getItem('micro-left-w')) || 260)
  const [rightW, setRightW] = useState(() => Number(localStorage.getItem('micro-right-w')) || 320)
  const [atBottom, setAtBottom] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  // True while the user is composing a brand-new session, so the session poll
  // does not immediately re-select the newest one (that made "+ new" a no-op).
  const composing = useRef(false)

  // "Busy" is per session, not one global switch: several sessions can run in
  // parallel. Derived from the server's status (polled) plus a local pending flag
  // while the POST is in flight.
  const currentMeta = sessions.find((s) => s.id === current)
  const busy = current ? pending[current] === true || currentMeta?.status === 'active' : pending[NEW_KEY] === true

  // Remember whether the session rail is open.
  useEffect(() => {
    localStorage.setItem('micro-sidebar', showSidebar ? '1' : '0')
  }, [showSidebar])

  // Remember whether the detail panel is open.
  useEffect(() => {
    localStorage.setItem('micro-panel', showPanel ? '1' : '0')
  }, [showPanel])

  // Remember the column widths.
  useEffect(() => {
    localStorage.setItem('micro-left-w', String(leftW))
  }, [leftW])
  useEffect(() => {
    localStorage.setItem('micro-right-w', String(rightW))
  }, [rightW])

  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.list()
      setSessions(list)
      // Auto-open the newest session on first load so the app is never blank —
      // but never override an explicit "new session".
      if (!composing.current) setCurrent((cur) => cur ?? list[0]?.id ?? null)
    } catch (err) {
      setError(String((err as Error).message))
    }
  }, [])

  useEffect(() => {
    void refreshSessions()
    const t = setInterval(() => void refreshSessions(), 5000)
    return () => clearInterval(t)
  }, [refreshSessions])

  // Available models come from the server (MICRO_MODELS); remember the choice.
  useEffect(() => {
    void api
      .models()
      .then((d) => {
        setModels(d.models)
        setModel((cur) => cur || d.default)
      })
      .catch(() => {})
  }, [])

  const chooseModel = (m: string): void => {
    setModel(m)
    localStorage.setItem('micro-model', m)
    // If a session is open, switch its model too (takes effect on the next run).
    if (current) {
      void api
        .setModel(current, m)
        .then(() => void refreshSessions())
        .catch((err: unknown) => setError(String((err as Error).message)))
    }
  }

  // 权限读取和保存使用同一个会话作用域，切换后旧响应全部失效。
  useEffect(() => {
    const session = current
    const scope = createPermissionScope({
      load: () => api.permission(session ?? undefined).then((d) => d.session ?? d.default),
      save: (preset) => api.setPermission(preset, session ?? undefined),
      publish: (state) => setPermission({ ...state, session }),
      fail: (err) => setError(String((err as Error).message)),
    })
    permissionScope.current = scope
    return () => { scope.dispose(); permissionScope.current = null }
  }, [current])

  // 加载中、提交中及跨会话的旧控件回调均不可发起修改。
  const changePermission = (preset: string): void => {
    if (permission.session !== current || permission.status !== 'ready') return
    permissionScope.current?.change(preset)
  }

  useEffect(() => {
    void api
      .limits()
      .then((d) => setMaxContext(d.maxContext))
      .catch(() => {})
  }, [])

  useEffect(() => {
    void api
      .sandbox()
      .then(setSandbox)
      .catch(() => {})
  }, [])

  // 工作目录变化时清空旧命令，并阻止旧目录响应覆盖当前会话。
  useEffect(() => {
    setCommands([])
    setSkills([])
    return loadScoped(
      () => api.commands(currentMeta?.cwd),
      (d) => { setCommands(d.templates); setSkills(d.skills) },
      (err) => setError(String((err as Error).message)),
    )
  }, [current, currentMeta?.cwd])

  useEffect(() => {
    void api
      .budget()
      .then((d) => setBudget(d.maxCost))
      .catch(() => {})
  }, [])

  // The runtime web switch; the web MCP server re-reads the file per call.
  useEffect(() => {
    void api
      .web()
      .then((d) => {
        setWebEnabled(d.enabled)
        setWebProvider(d.provider)
        setWebProviders(d.providers ?? [])
      })
      .catch(() => {})
  }, [])

  const toggleWeb = (): void => {
    const next = !webEnabled
    setWebEnabled(next)
    void api
      .setWeb({ enabled: next })
      .then((d) => setWebEnabled(d.enabled))
      .catch((err: unknown) => {
        setWebEnabled(!next)
        setError(String((err as Error).message))
      })
  }

  const stopRun = (): void => {
    if (!current) return
    void api
      .stop(current)
      .then(() => void refreshSessions())
      .catch((err: unknown) => setError(String((err as Error).message)))
  }

  const changeProvider = (id: string): void => {
    const prev = webProvider
    setWebProvider(id)
    void api
      .setWeb({ provider: id })
      .then((d) => setWebProvider(d.provider))
      .catch((err: unknown) => {
        setWebProvider(prev)
        setError(String((err as Error).message))
      })
  }

  // ⌘K / Ctrl+K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setHelpOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // 快照和事件流共享生命周期，切换会话或重启订阅后旧回调全部失效。
  useEffect(() => {
    // 新会话清除旧错误；空会话同时清除旧事件。
    setError('')
    if (!current) {
      setEvents([])
      return
    }
    return startSessionLifecycle({
      load: () => api.get(current),
      subscribe: (handlers) => api.subscribe(current, handlers),
      replace: setEvents,
      // 历史重放与实时流可能重复，按完整事件标识保留一份。
      append: (e) => setEvents((prev) => prev.some((x) =>
        x.agentId === e.agentId && x.seq === e.seq && x.t === e.t,
      ) ? prev : [...prev, e]),
      receive: (e) => {
        // 服务端回显确认消息后移除本地乐观消息。
        if (e.event.type === 'user.message') {
          const ev = e.event as { content?: unknown; text?: unknown }
          const text = String(ev.content ?? ev.text ?? '')
          setOptimistic((prev) => {
            const i = prev.findIndex((o) => o.sent === text || o.text === text)
            if (i === -1) return prev
            const next = prev.slice()
            next.splice(i, 1)
            return next
          })
        } else if (e.event.type === 'error') {
          // 运行失败时撤销尚未确认的本地消息。
          setOptimistic([])
        }
      },
      fail: (err) => setError(String((err as Error).message)),
    })
  }, [current, runTick])

  const shown = useMemo(() => (replayAt == null ? events : truncate(events, replayAt)), [events, replayAt])
  const usageSeries = useMemo(() => deriveUsageSeries(shown), [shown])
  const usageStats = useMemo(() => deriveUsageStats(shown), [shown])
  const chat = useMemo(() => deriveChat(shown), [shown])
  // Chat + any not-yet-acknowledged local echoes.
  const items = useMemo(() => withOptimistic(chat, optimistic), [chat, optimistic])
  const tree = useMemo(() => deriveAgents(shown), [shown])
  const task = useMemo(() => replayAt == null ? taskProjector.current.update(events) : deriveTask(shown), [events, replayAt, shown])
  const completeTask = useCallback(async () => {
    if (!current || task.status !== 'awaiting_verification') return
    try {
      await api.updateTask(current, { status: 'completed', expectedRevision: task.revision })
      const refreshed = await api.get(current)
      setEvents(refreshed.events)
    } catch (err) {
      setError(String((err as Error).message))
    }
  }, [current, task.revision, task.status])
  const requests = useMemo(() => deriveInspector(shown), [shown])
  const approvals = useMemo(() => pendingApprovals(events), [events])

  // Follow the stream only while the user is parked at the bottom — scrolling up
  // freezes the view (and surfaces a "back to bottom" pill).
  useEffect(() => {
    if (!atBottom) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items.length, items[items.length - 1]?.kind, atBottom, current])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  const scrollToBottom = (): void => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setAtBottom(true)
  }

  // Notify when a run lands while the tab is in the background.
  const prevBusy = useRef(false)
  useEffect(() => {
    if (
      prevBusy.current &&
      !busy &&
      document.hidden &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      new Notification('micro-harness', { body: t('notify.done') })
    }
    prevBusy.current = busy
  }, [busy, t])

  const downloadMarkdown = (): void => {
    const meta = sessions.find((s) => s.id === current)
    const md = toMarkdown(chat, { id: current ?? undefined, title: meta?.title, model: meta?.model })
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${(meta?.title || current || 'session').slice(0, 40)}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || busy) return
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
    setError('')
    setInput('')
    const attached = images
    setImages([])
    // Non-image attachments ride along as <file> blocks the agent can read.
    const typed = text
    const withFiles =
      files.length > 0
        ? typed + '\n\n' + files.map((f) => `<file name="${f.name}">\n${f.text}\n</file>`).join('\n\n')
        : typed
    setFiles([])
    const key = current ?? NEW_KEY
    setPending((p) => ({ ...p, [key]: true }))
    const optId = `opt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    setOptimistic((prev) => [...prev, { id: optId, text: typed, sent: withFiles, t: Date.now() }])
    try {
      if (current) {
        await api.resume(current, withFiles, attached)
        setRunTick((t) => t + 1)
      } else {
        const meta = await api.create(withFiles, { model: model || undefined, images: attached })
        composing.current = false
        setCurrent(meta.id)
      }
      void refreshSessions()
    } catch (err) {
      setError(String((err as Error).message))
      setOptimistic((prev) => prev.filter((o) => o.id !== optId))
    } finally {
      setPending((p) => {
        const next = { ...p }
        delete next[key]
        return next
      })
    }
  }

  /** Rename a session in place (PATCH), then refresh the list. */
  const renameSession = (id: string, title: string): void => {
    void api
      .rename(id, title)
      .then(() => void refreshSessions())
      .catch((err: unknown) => setError(String((err as Error).message)))
  }

  /**
   * Edit a user message and resend: fork the session truncated to just before that
   * message (`at` is its index in the event array), then run the edited prompt in
   * the fork — the original session is left untouched.
   */
  const editResend = async (at: number, text: string): Promise<void> => {
    if (!current) return
    const key = current
    setPending((p) => ({ ...p, [key]: true }))
    setError('')
    try {
      const forked = await api.fork(current, at)
      composing.current = false
      setCurrent(forked.id)
      setEvents([])
      setReplayAt(null)
      await api.resume(forked.id, text)
      setRunTick((t) => t + 1)
      void refreshSessions()
    } catch (err) {
      setError(String((err as Error).message))
    } finally {
      setPending((p) => {
        const next = { ...p }
        delete next[key]
        return next
      })
    }
  }

  const toggleTheme = (): void => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('micro-theme', next ? 'dark' : 'light')
  }

  /** Answer a pending approval, then refresh so the `permission.result` shows up. */
  const onDecide = useCallback(
    (id: string, allow: boolean): Promise<void> => {
      if (!current) return Promise.resolve()
      return decidePermission(current, id, allow)
        .then(() => {
          // The SSE stream usually delivers the result already; re-fetch to be sure.
          void api
            .get(current)
            .then((d) => setEvents(d.events))
            .catch(() => {})
        })
        .catch((err: unknown) => {
          setError(String((err as Error).message))
        })
    },
    [current],
  )

  /** Drag a divider to resize a side column, clamped so main stays usable. */
  const startResize = (side: 'left' | 'right') => (e: React.PointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = side === 'left' ? leftW : rightW
    const min = side === 'left' ? 180 : 220
    const max = side === 'left' ? 480 : 560
    const onMove = (ev: PointerEvent): void => {
      const next = startW + (side === 'left' ? ev.clientX - startX : startX - ev.clientX)
      const clamped = Math.max(min, Math.min(max, next))
      if (side === 'left') setLeftW(clamped)
      else setRightW(clamped)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.style.userSelect = ''
    }
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const paletteActions: PaletteAction[] = useMemo(
    () => [
      { id: 'new', label: t('palette.newSession'), run: () => { composing.current = true; setCurrent(null); setEvents([]); setOptimistic([]); setFiles([]) } },
      { id: 'chat', label: t('tabs.chat'), run: () => setView('chat') },
      { id: 'trace', label: t('tabs.trace'), run: () => setView('trace') },
      { id: 'changes', label: t('tabs.changes'), run: () => setView('changes') },
      { id: 'theme', label: t('palette.theme'), run: toggleTheme },
      { id: 'lang', label: t('palette.lang'), run: () => setLang(lang === 'zh' ? 'en' : 'zh') },
      { id: 'export', label: t('palette.exportMd'), run: downloadMarkdown },
      {
        id: 'trace-json',
        label: t('palette.copyTrace'),
        run: () => void navigator.clipboard?.writeText(JSON.stringify(events, null, 2)),
      },
      { id: 'help', label: t('palette.shortcuts'), run: () => setHelpOpen(true) },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, lang, setLang, chat, events, current, sessions],
  )

  return (
    <div className="flex h-full flex-col">
      <Header
        current={current}
        tokens={tree.total.input + tree.total.output}
        cost={tree.total.cost}
        priced={usageStats.pricing !== 'none'}
        budget={budget}
        sandbox={sandbox}
        series={usageSeries}
        busy={busy}
        dark={dark}
        webEnabled={webEnabled}
        webProvider={webProvider}
        webProviders={webProviders}
        onChangeProvider={changeProvider}
        onToggleTheme={toggleTheme}
        onToggleWeb={toggleWeb}
        onToggleSessions={() => setShowSidebar((v) => !v)}
        onTogglePanel={() => setShowPanel((v) => !v)}
        onShowUsage={() => setUsageOpen(true)}
      />

      {error && (
        <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* Persistent rail: inline, never an overlay — so interacting with the
            composer (or anything in main) can't dismiss it. */}
        <aside
          style={{ width: leftW }}
          className={`${
            showSidebar ? 'flex' : 'hidden'
          } shrink-0 flex-col border-r border-border bg-background`}
        >
          <Sidebar
            sessions={sessions}
            current={current}
            onSelect={(id) => {
              composing.current = false
              setCurrent(id)
              setReplayAt(null)
              setOptimistic([])
              setFiles([])
            }}
            onNew={() => {
              composing.current = true
              setCurrent(null)
              setEvents([])
              setOptimistic([])
              setFiles([])
            }}
            onRename={renameSession}
            onDelete={(id) => {
              void api
                .remove(id)
                .then(() => {
                  if (id === current) {
                    composing.current = true
                    setCurrent(null)
                    setEvents([])
                  }
                  void refreshSessions()
                })
                .catch((err: unknown) => setError(String((err as Error).message)))
            }}
          />
        </aside>

        {showSidebar && <Divider onResize={startResize('left')} />}

        <main className={`relative flex min-w-0 flex-1 flex-col ${replayAt != null ? 'saturate-[0.8]' : ''}`}>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className={replayAt == null ? 'bg-dots min-h-0 flex-1 overflow-y-auto px-4 py-4' : 'min-h-0 flex-1 overflow-y-auto bg-gold/5 px-4 py-4'}
          >
            <Transcript
              items={items}
              onEditResend={(at, text) => void editResend(at, text)}
              approvals={approvals}
              onDecide={(id, allow) => void onDecide(id, allow)}
            />
          </div>
          {replayAt != null && (
            <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-gold/50 bg-gold/15 px-2.5 py-0.5 font-mono text-[10px] font-medium tracking-widest text-gold">
              {t('replay.badge')}
            </div>
          )}
          {!atBottom && (
            <button
              onClick={scrollToBottom}
              className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2 rounded-full border border-border bg-card/90 px-3 py-1 text-[11px] font-medium shadow-lg backdrop-blur transition hover:border-teal/50 hover:text-teal"
            >
              ↓ {t('chat.toBottom')}
            </button>
          )}
          <Composer
            value={input}
            setValue={setInput}
            onSend={() => void send()}
            busy={busy}
            onStop={stopRun}
            commands={commands}
            skills={skills}
            models={models}
            model={model}
            setModel={chooseModel}
            images={images}
            setImages={setImages}
            files={files}
            setFiles={setFiles}
            permission={permission.session === current ? permission.value ?? undefined : undefined}
            permissionStatus={permission.session === current ? permission.status : 'loading'}
            onPermission={changePermission}
          />
        </main>

        {/* Persistent panel: inline, not an overlay — same reasoning as the rail. */}
        {showPanel && <Divider onResize={startResize('right')} />}
        <aside
          style={{ width: rightW }}
          className={`${
            showPanel ? 'flex' : 'hidden'
          } shrink-0 flex-col border-l border-border bg-background`}
        >
          <div role="tablist" aria-label={t('a11y.tabs')} className="flex shrink-0 gap-1 border-b border-border p-2">
            {VIEWS.map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                aria-controls={`panel-${v}`}
                onClick={() => setView(v)}
                className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
                  view === v ? 'bg-teal/15 text-teal' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {t(`tabs.${v}`)}
              </button>
            ))}
          </div>
          <div id={`panel-${view}`} role="tabpanel" key={view} className="animate-slide min-h-0 flex-1">
            {view === 'chat' ? (
              <AgentsPanel roots={tree.roots} total={tree.total} />
            ) : view === 'task' ? (
              <TaskPanel task={task} onComplete={completeTask} />
            ) : view === 'trace' ? (
              <TracePanel events={events} replayAt={replayAt} setReplayAt={setReplayAt} />
            ) : view === 'inspector' ? (
              <InspectorPanel requests={requests} />
            ) : view === 'artifacts' ? (
              <ArtifactsPanel sessionId={current} />
            ) : current ? (
              <ChangesPanel sessionId={current} />
            ) : null}
          </div>
        </aside>
      </div>

      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <UsagePanel open={usageOpen} events={events} maxContext={maxContext} onClose={() => setUsageOpen(false)} />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
        onOpenSession={(id) => {
          composing.current = false
          setCurrent(id)
          setReplayAt(null)
        }}
      />
    </div>
  )
}
