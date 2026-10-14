/**
 * HTTP + SSE server — ROADMAP P4.
 *
 * A thin, event-first API over the `Harness`:
 *
 *   GET    /health
 *   GET    /api/sessions                 list sessions
 *   POST   /api/sessions                 create + start a session  { prompt, model?, cwd? }
 *   GET    /api/sessions/:id             session header + recorded events
 *   DELETE /api/sessions/:id             delete a session
 *   POST   /api/sessions/:id/resume      continue a session        { prompt }
 *   POST   /api/sessions/:id/fork        copy a session to a new id
 *   GET    /api/sessions/:id/events      SSE stream (replay + live)
 *   GET    /api/search?q=…               FTS5 full-text search
 *
 * Auth: when bound beyond loopback a bearer token is mandatory; it is also
 * enforced whenever `token` is configured. SSE clients may pass `?token=`.
 */

import { EventHub, Harness, defaultSystemPrompt, type Provider, reconstructMessages, type TaggedEvent, type Tool } from '@micro-harness/core'
import type { Server } from 'bun'
import { SessionStore, type SessionMeta } from './store.ts'

export interface ServerOptions {
  store: SessionStore
  provider: Provider
  /** Model used for new sessions/forks (roles may override later). */
  model: string
  /** Working directory for the agent's tools. */
  cwd: string
  tools?: Tool[]
  maxSteps?: number
  systemPrompt?: string
  pricing?: { input: number; output: number }
  /** Bind host; defaults to loopback. Non-loopback requires a token. */
  hostname?: string
  port?: number
  /** Extra bearer token; if set, every request must present it. */
  token?: string
  /** Force token auth even on loopback (tests / reverse proxies). */
  requireAuth?: boolean
}

export interface SessionRuntime {
  meta: SessionMeta
  harness: Harness
  hub: Harness['hub']
  controller: AbortController
  done: Promise<void>
  /** Detach this run's store listener once it finishes. */
  off: () => void
}

export interface HarnessServer {
  server: Server<unknown>
  store: SessionStore
  hostname: string
  port: number
  url: string
  runtime(id: string): SessionRuntime | undefined
  /** Resolve when the session's current run finishes (immediately if idle). */
  idle(id: string): Promise<void>
  stop(closeStore?: boolean): void
}

const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '::1'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export function createServer(options: ServerOptions): HarnessServer {
  const { store, provider, model } = options
  const hostname = options.hostname ?? '127.0.0.1'
  const authRequired = options.requireAuth ?? !isLoopback(hostname)
  if (authRequired && !options.token) throw new Error('a server token is required when binding beyond loopback')

  const runtimes = new Map<string, SessionRuntime>()
  const cwd = options.cwd
  const tools = options.tools

  const build = (meta: SessionMeta): SessionRuntime => {
    const hub = new EventHub()
    // Attach persistence *before* the Harness emits its `session.start`.
    const off = hub.on((e: TaggedEvent) => store.append(meta.id, e))
    const harness = new Harness({
      provider,
      model: meta.model || model,
      cwd: meta.cwd || cwd,
      tools,
      hub,
      maxSteps: options.maxSteps,
      systemPrompt: options.systemPrompt,
      pricing: options.pricing,
      agentId: 'main',
      parentId: meta.parentId ?? null,
    })
    return { meta, harness, hub, controller: new AbortController(), done: Promise.resolve(), off }
  }

  const start = (runtime: SessionRuntime, prompt: string): void => {
    runtime.done = (async () => {
      try {
        await runtime.harness.send(prompt, runtime.controller.signal)
      } catch (err) {
        store.update(runtime.meta.id, { status: 'error' })
        runtime.hub.forward({
          agentId: 'main',
          parentId: null,
          seq: 0,
          t: Date.now(),
          event: { type: 'error', message: String((err as Error)?.message || err), fatal: true },
        })
      } finally {
        runtime.off()
      }
    })()
  }

  const create = (body: { prompt?: string; model?: string; cwd?: string; title?: string }): SessionMeta => {
    const meta = store.create({
      title: body.title ?? body.prompt?.slice(0, 100) ?? '',
      model: body.model ?? model,
      cwd: body.cwd ?? cwd,
    })
    const runtime = build(meta)
    runtimes.set(meta.id, runtime)
    if (body.prompt) start(runtime, body.prompt)
    return meta
  }

  const resume = (id: string, prompt: string): SessionRuntime => {
    const meta = store.require(id)
    const system = options.systemPrompt ?? defaultSystemPrompt(meta.cwd || cwd)
    const reconstructed = reconstructMessages(store.events(id), system, 'main')
    const runtime = build({ ...meta, status: 'active' })
    runtime.harness.messages.splice(0, runtime.harness.messages.length, ...reconstructed)
    runtimes.set(id, runtime)
    start(runtime, prompt)
    return runtime
  }

  const fork = (id: string): SessionMeta => {
    const source = store.require(id)
    const copy = store.create({
      title: source.title ? `${source.title} (fork)` : '(fork)',
      model: source.model,
      cwd: source.cwd,
      parentId: source.id,
    })
    store.appendAll(copy.id, store.events(id))
    return store.require(copy.id)
  }

  const sse = (id: string, req: Request): Response => {
    if (!store.has(id)) return json({ error: 'session not found' }, 404)
    const encoder = new TextEncoder()
    const runtime = runtimes.get(id)
    let write: ((chunk: string) => void) | null = null
    let off: (() => void) | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        write = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk))
          } catch {
            /* closed */
          }
        }
        // 1. replay what already happened
        for (const event of store.events(id)) write(`data: ${JSON.stringify(event)}\n\n`)
        // 2. live-tail a running session
        if (runtime && !runtime.controller.signal.aborted) {
          off = runtime.hub.on((e) => write?.(`data: ${JSON.stringify(e)}\n\n`))
          heartbeat = setInterval(() => write?.(': ping\n\n'), 15_000)
          runtime.done.finally(() => {
            write?.('event: end\ndata: {}\n\n')
            try {
              controller.close()
            } catch {
              /* already closed */
            }
          })
        } else {
          write('event: end\ndata: {}\n\n')
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }
        req.signal.addEventListener('abort', () => {
          off?.()
          if (heartbeat) clearInterval(heartbeat)
        })
      },
      cancel() {
        off?.()
        if (heartbeat) clearInterval(heartbeat)
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    })
  }

  const authorized = (req: Request, url: URL): boolean => {
    if (!options.token) return !authRequired
    const header = req.headers.get('authorization') ?? ''
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    const query = url.searchParams.get('token') ?? ''
    return bearer === options.token || query === options.token
  }

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)

    if (url.pathname === '/health' || url.pathname === '/') {
      return json({ ok: true, name: 'micro-harness', version: '0.1.0' })
    }
    if (!authorized(req, url)) return json({ error: 'unauthorized' }, 401)

    // /api/sessions
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts.length === 2) {
      if (req.method === 'GET') return json({ sessions: store.list() })
      if (req.method === 'POST') {
        let body: { prompt?: string; model?: string; cwd?: string; title?: string } = {}
        try {
          body = (await req.json()) as typeof body
        } catch {
          /* empty body is fine */
        }
        const meta = create(body)
        return json({ session: meta }, 201)
      }
      return json({ error: 'method not allowed' }, 405)
    }

    // /api/sessions/:id[...]
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2]) {
      const id = decodeURIComponent(parts[2])
      const action = parts[3]
      if (action === 'events') {
        if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405)
        return sse(id, req)
      }
      if (action === 'resume') {
        if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
        if (!store.has(id)) return json({ error: 'session not found' }, 404)
        let body: { prompt?: string } = {}
        try {
          body = (await req.json()) as typeof body
        } catch {
          /* empty */
        }
        if (!body.prompt) return json({ error: 'prompt is required' }, 400)
        resume(id, body.prompt)
        return json({ session: store.require(id) }, 202)
      }
      if (action === 'fork') {
        if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
        if (!store.has(id)) return json({ error: 'session not found' }, 404)
        return json({ session: fork(id) }, 201)
      }
      if (action) return json({ error: 'not found' }, 404)
      if (req.method === 'GET') {
        if (!store.has(id)) return json({ error: 'session not found' }, 404)
        return json({ session: store.require(id), events: store.events(id) })
      }
      if (req.method === 'DELETE') {
        if (!store.delete(id)) return json({ error: 'session not found' }, 404)
        runtimes.delete(id)
        return json({ ok: true })
      }
      return json({ error: 'method not allowed' }, 405)
    }

    // /api/search?q=…
    if (parts[0] === 'api' && parts[1] === 'search') {
      const q = url.searchParams.get('q') ?? ''
      if (!q.trim()) return json({ error: 'q is required' }, 400)
      return json({ query: q, hits: store.search(q, Number(url.searchParams.get('limit')) || 20) })
    }

    return json({ error: 'not found' }, 404)
  }

  const server = Bun.serve({ hostname, port: options.port ?? 0, fetch })
  const port = server.port ?? 0

  return {
    server,
    store,
    hostname,
    port,
    url: `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${port}`,
    runtime: (id) => runtimes.get(id),
    idle: async (id) => {
      await runtimes.get(id)?.done
    },
    stop: (closeStore = false) => {
      server.stop(true)
      if (closeStore) store.close()
    },
  }
}
