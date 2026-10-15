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

const TOKEN = new URLSearchParams(location.search).get('token') ?? localStorage.getItem('micro-token') ?? ''

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
  create: (prompt: string, title?: string) =>
    j<{ session: SessionMeta }>('/api/sessions', { method: 'POST', body: JSON.stringify({ prompt, title }) }).then((d) => d.session),
  resume: (id: string, prompt: string) =>
    j<{ session: SessionMeta }>(`/api/sessions/${id}/resume`, { method: 'POST', body: JSON.stringify({ prompt }) }).then(
      (d) => d.session,
    ),
  fork: (id: string) => j<{ session: SessionMeta }>(`/api/sessions/${id}/fork`, { method: 'POST' }).then((d) => d.session),
  remove: (id: string) => j<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),
  search: (q: string) => j<{ hits: unknown[] }>(`/api/search?q=${encodeURIComponent(q)}`),
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
