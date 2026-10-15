import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type SessionMeta, type TaggedEvent } from './lib/api.ts'
import { useT } from './lib/i18n.tsx'
import { deriveAgents, deriveChat, deriveInspector, deriveUsageSeries, toMarkdown, truncate } from './lib/derive.ts'
import { Header } from './components/Header.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Transcript } from './components/Transcript.tsx'
import { Composer } from './components/Composer.tsx'
import { AgentsPanel } from './components/AgentsPanel.tsx'
import { TracePanel } from './components/TracePanel.tsx'
import { ChangesPanel } from './components/ChangesPanel.tsx'
import { InspectorPanel } from './components/InspectorPanel.tsx'
import { CommandPalette, type PaletteAction } from './components/CommandPalette.tsx'
import { ShortcutsDialog } from './components/ShortcutsDialog.tsx'

type View = 'chat' | 'trace' | 'changes' | 'inspector'
const VIEWS: View[] = ['chat', 'trace', 'changes', 'inspector']

export default function App() {
  const { t, lang, setLang } = useT()
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [events, setEvents] = useState<TaggedEvent[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<View>('chat')
  const [replayAt, setReplayAt] = useState<number | null>(null)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const [runTick, setRunTick] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState(() => localStorage.getItem('micro-model') ?? '')
  const [showSidebar, setShowSidebar] = useState(() => window.matchMedia('(min-width: 768px)').matches)
  const [showPanel, setShowPanel] = useState(() => window.matchMedia('(min-width: 1024px)').matches)
  const [atBottom, setAtBottom] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  // True while the user is composing a brand-new session, so the session poll
  // does not immediately re-select the newest one (that made "+ new" a no-op).
  const composing = useRef(false)

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
  const usageSeries = useMemo(() => deriveUsageSeries(shown), [shown])
  const chat = useMemo(() => deriveChat(shown), [shown])
  const tree = useMemo(() => deriveAgents(shown), [shown])
  const requests = useMemo(() => deriveInspector(shown), [shown])

  // Follow the stream only while the user is parked at the bottom — scrolling up
  // freezes the view (and surfaces a "back to bottom" pill).
  useEffect(() => {
    if (!atBottom) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length, chat[chat.length - 1]?.kind, atBottom, current])

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
    setBusy(true)
    setError('')
    setInput('')
    try {
      if (current) {
        await api.resume(current, text)
        setRunTick((t) => t + 1)
      } else {
        const meta = await api.create(text, { model: model || undefined })
        composing.current = false
        setCurrent(meta.id)
      }
      void refreshSessions()
    } catch (err) {
      setError(String((err as Error).message))
    } finally {
      setBusy(false)
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
    setBusy(true)
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
      setBusy(false)
    }
  }

  const toggleTheme = (): void => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('micro-theme', next ? 'dark' : 'light')
  }

  const isMobile = (): boolean => window.matchMedia('(max-width: 767px)').matches

  const paletteActions: PaletteAction[] = useMemo(
    () => [
      { id: 'new', label: t('palette.newSession'), run: () => { composing.current = true; setCurrent(null); setEvents([]) } },
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
        series={usageSeries}
        busy={busy}
        dark={dark}
        onToggleTheme={toggleTheme}
        onToggleSessions={() => setShowSidebar((v) => !v)}
        onTogglePanel={() => setShowPanel((v) => !v)}
      />

      {error && (
        <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {/* mobile backdrop for the session drawer */}
        {showSidebar && (
          <div
            className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm md:hidden"
            aria-hidden="true"
            onClick={() => setShowSidebar(false)}
          />
        )}
        <aside
          className={`${
            showSidebar ? 'flex' : 'hidden'
          } fixed inset-y-0 left-0 z-40 w-[260px] shrink-0 flex-col border-r border-border bg-background shadow-xl md:static md:z-auto md:shadow-none`}
        >
          <Sidebar
            sessions={sessions}
            current={current}
            onSelect={(id) => {
              composing.current = false
              setCurrent(id)
              setReplayAt(null)
              if (isMobile()) setShowSidebar(false)
            }}
            onNew={() => {
              composing.current = true
              setCurrent(null)
              setEvents([])
              if (isMobile()) setShowSidebar(false)
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

        <main className={`relative flex min-w-0 flex-1 flex-col ${replayAt != null ? 'saturate-[0.8]' : ''}`}>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className={replayAt == null ? 'bg-dots min-h-0 flex-1 overflow-y-auto px-4 py-4' : 'min-h-0 flex-1 overflow-y-auto bg-gold/5 px-4 py-4'}
          >
            <Transcript items={chat} onEditResend={(at, text) => void editResend(at, text)} />
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
            models={models}
            model={model}
            setModel={chooseModel}
          />
        </main>

        {/* backdrop for the side panel on narrow windows */}
        {showPanel && (
          <div
            className="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm lg:hidden"
            aria-hidden="true"
            onClick={() => setShowPanel(false)}
          />
        )}
        <aside
          className={`${
            showPanel ? 'flex' : 'hidden'
          } fixed inset-y-0 right-0 z-40 w-[320px] max-w-[88vw] shrink-0 flex-col border-l border-border bg-background shadow-xl lg:static lg:z-auto lg:shadow-none`}
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
            ) : view === 'trace' ? (
              <TracePanel events={events} replayAt={replayAt} setReplayAt={setReplayAt} />
            ) : view === 'inspector' ? (
              <InspectorPanel requests={requests} />
            ) : current ? (
              <ChangesPanel sessionId={current} />
            ) : null}
          </div>
        </aside>
      </div>

      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />

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
