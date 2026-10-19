/**
 * Client for the micro-harness server (`packages/server`).
 * Token comes from `?token=` or localStorage, matching the server's auth.
 */

export interface AgentEvent {
  type: string
  [key: string]: unknown
}

export interface TaggedEvent {
  agentId: string
  parentId: string | null
  seq: number
  t: number
  event: AgentEvent
}

export interface SessionMeta {
  id: string
  title: string
  model: string
  cwd: string
  parentId: string | null
  status: 'active' | 'done' | 'error'
  createdAt: number
  updatedAt: number
  input: number
  output: number
  cost: number
}

export interface SearchHit {
  sessionId: string
  agentId: string
  type: string
  content?: string
  title?: string
  model?: string
}

/** An image attached to a prompt (base64, no data-URL prefix). */
export interface ImageInput {
  mimeType: string
  data: string
}

/** A non-image file the user attached; its text rides along with the prompt. */
export interface FileAttachment {
  name: string
  size: number
  text: string
}

/** One search backend the GUI may pick; `configured` is false when its key/URL is missing. */
export interface WebProvider {
  id: string
  label: string
  configured: boolean
}

export interface WebState {
  mode: string
  enabled: boolean
  provider: string
  providers: WebProvider[]
  toggleFile?: string
}

export interface AgentWorktree {
  agentId: string
  path: string
  branch: string
  base: string
}

export interface AgentDiff {
  agentId: string
  worktree: AgentWorktree
  files: Array<{ path: string; add: number; del: number; status: string }>
  diff: string
}

export interface IntegrateBlock {
  type: 'text' | 'conflict'
  text?: string
  ours?: string
  base?: string
  theirs?: string
}

export interface IntegrateFile {
  path: string
  status: string
  clean: boolean
  content?: string
  blocks?: IntegrateBlock[]
  agents: string[]
  pending: string[]
  binary?: boolean
  skipped?: boolean
  delete?: boolean
}

const TOKEN =
  typeof location !== 'undefined' && typeof localStorage !== 'undefined'
    ? (new URLSearchParams(location.search).get('token') ?? localStorage.getItem('micro-token') ?? '')
    : ''

export function withToken(path: string): string {
  if (!TOKEN) return path
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN)
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withToken(path), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → HTTP ${res.status}`)
  return (await res.json()) as T
}

export const api = {
  list: () => j<{ sessions: SessionMeta[] }>('/api/sessions').then((d) => d.sessions),
  get: (id: string) => j<{ session: SessionMeta; events: TaggedEvent[] }>(`/api/sessions/${id}`),
  models: () => j<{ models: string[]; default: string }>('/api/models'),
  create: (prompt: string, opts: { title?: string; model?: string; images?: ImageInput[] } = {}) =>
    j<{ session: SessionMeta }>('/api/sessions', { method: 'POST', body: JSON.stringify({ prompt, ...opts }) }).then(
      (d) => d.session,
    ),
  resume: (id: string, prompt: string, images?: ImageInput[]) =>
    j<{ session: SessionMeta }>(`/api/sessions/${id}/resume`, {
      method: 'POST',
      body: JSON.stringify({ prompt, ...(images?.length ? { images } : {}) }),
    }).then(
      (d) => d.session,
    ),
  /** Copy a session. `keep` limits the copy to the first N events (for edit-and-resend). */
  fork: (id: string, keep?: number) =>
    j<{ session: SessionMeta }>(`/api/sessions/${id}/fork`, {
      method: 'POST',
      body: JSON.stringify(keep === undefined ? {} : { keep }),
    }).then((d) => d.session),
  /** Retitle a session in place. */
  rename: (id: string, title: string) =>
    j<{ session: SessionMeta }>(`/api/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }).then(
      (d) => d.session,
    ),
  /** Change which model a session uses, from its next run on. */
  setModel: (id: string, model: string) =>
    j<{ session: SessionMeta }>(`/api/sessions/${id}/model`, {
      method: 'POST',
      body: JSON.stringify({ model }),
    }).then((d) => d.session),
  remove: (id: string) => j<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  search: (q: string) => j<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  /** Permission presets: what the agent may touch, and whether it must ask. */
  permission: (sessionId?: string) =>
    j<{ default: string; session?: string; presets: { id: string; exp?: boolean }[] }>(
      `/api/permission${sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''}`,
    ),
  setPermission: (preset: string, sessionId?: string) =>
    sessionId
      ? j<{ ok: boolean }>(`/api/sessions/${sessionId}/permission`, {
          method: 'POST',
          body: JSON.stringify({ preset }),
        })
      : j<{ ok: boolean }>('/api/permission', { method: 'POST', body: JSON.stringify({ preset }) }),
  /** The per-run cost budget, when one is configured. */
  budget: () => j<{ maxCost: number | null }>('/api/budget'),
  /** The runtime web switch; the MCP server re-reads the toggle file per call. */
  web: () => j<WebState>('/api/web'),
  setWeb: (patch: { enabled?: boolean; provider?: string }) =>
    j<{ ok: boolean; enabled: boolean; provider: string }>('/api/web', {
      method: 'POST',
      body: JSON.stringify(patch),
    }),
  /** Answer a pending tool-call approval (allow/deny). */
  decidePermission: (id: string, requestId: string, allow: boolean) =>
    j<{ ok: boolean }>(`/api/sessions/${id}/permissions/${encodeURIComponent(requestId)}`, {
      method: 'POST',
      body: JSON.stringify({ allow }),
    }),

  // --- workspace isolation + merge queue (P7) ---
  agents: (id: string) => j<{ agents: AgentWorktree[] }>(`/api/sessions/${id}/agents`).then((d) => d.agents),
  agentDiff: (id: string, agentId: string) =>
    j<AgentDiff>(`/api/sessions/${id}/agents/${encodeURIComponent(agentId)}/diff`),
  promoteAgent: (id: string, agentId: string) =>
    j<{ ok: boolean; applied: string[]; conflicts: string[]; error?: string }>(
      `/api/sessions/${id}/agents/${encodeURIComponent(agentId)}/promote`,
      { method: 'POST' },
    ),
  /**
   * Apply only the selected hunks of an agent's diff (indices from
   * `splitDiffHunks`) to the shared workspace. Reuses the integrate/apply path, so
   * backups and conflict reporting come for free.
   */
  applyHunks: (id: string, agentId: string, hunks: number[]) =>
    j<{ applied: string[]; conflicted: number[]; backup?: string }>(
      `/api/sessions/${id}/agents/${encodeURIComponent(agentId)}/apply`,
      { method: 'POST', body: JSON.stringify({ hunks }) },
    ),
  integrate: (id: string) => j<{ base?: string; files: IntegrateFile[] }>(`/api/sessions/${id}/integrate`),
  integrateApply: (id: string, files: Array<{ path: string; content?: string; delete?: boolean; takeTheirs?: boolean; agentId?: string }>) =>
    j<{ applied: string[]; backup?: string }>(`/api/sessions/${id}/integrate`, {
      method: 'POST',
      body: JSON.stringify({ files }),
    }),
  /** Abort the run in progress (the GUI's stop button). */
  stop: (id: string) => j<{ ok: boolean; stopped: boolean }>(`/api/sessions/${id}/stop`, { method: 'POST' }),
  /**
   * Subscribe to a session's event stream. Returns an unsubscribe function.
   *
   * The server replays history then live-tails the run; when the run finishes it
   * sends a named `end` event and closes the stream. That is a normal completion,
   * not an error — so we close the EventSource ourselves to stop its automatic
   * reconnect loop.
   */
  subscribe(
    id: string,
    handlers: { onEvent: (e: TaggedEvent) => void; onEnd?: () => void; onError?: (err: unknown) => void },
  ): () => void {
    const es = new EventSource(withToken(`/api/sessions/${id}/events`))
    let closed = false
    es.onmessage = (m) => {
      try {
        handlers.onEvent(JSON.parse(m.data) as TaggedEvent)
      } catch {
        /* ignore keep-alives / malformed frames */
      }
    }
    es.addEventListener('end', () => {
      closed = true
      es.close()
      handlers.onEnd?.()
    })
    es.onerror = () => {
      if (!closed && es.readyState !== EventSource.CLOSED) handlers.onError?.(new Error('event stream error'))
    }
    return () => {
      closed = true
      es.close()
    }
  },
}
