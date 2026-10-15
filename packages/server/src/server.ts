/**
 * HTTP + SSE server — ROADMAP P4.
 *
 * A thin, event-first API over the `Harness`:
 *
 *   GET    /health
 *   GET    /api/sessions                 list sessions
 *   POST   /api/sessions                 create + start a session  { prompt, model?, cwd? }
 *   GET    /api/models                   list model ids (default + optional list)
 *   GET    /api/mcp                      connected MCP servers + their tools
 *   GET    /api/sessions/:id             session header + recorded events
 *   PATCH  /api/sessions/:id             rename a session          { title }
 *   DELETE /api/sessions/:id             delete a session
 *   POST   /api/sessions/:id/resume      continue a session        { prompt }
 *   POST   /api/sessions/:id/fork        copy a session to a new id { keep? }
 *   POST   /api/sessions/:id/agents/:agentId/apply  apply accepted hunks of an agent's diff { hunks: number[] }
 *   GET    /api/sessions/:id/events      SSE stream (replay + live)
 *   GET    /api/search?q=…               FTS5 full-text search
 *
 * Auth: when bound beyond loopback a bearer token is mandatory; it is also
 * enforced whenever `token` is configured. SSE clients may pass `?token=`.
 */

import {
  AgentRunner,
  EventHub,
  Harness,
  applyHunkSelection,
  createAgentRegistry,
  defaultSystemPrompt,
  integrateApply,
  integratePreview,
  makeTaskTool,
  makeTools,
  promoteWorktree,
  reconstructMessages,
  removeWorktree,
  worktreeDiff,
  type AgentRole,
  type Provider,
  type TaggedEvent,
  type Tool,
  type McpServerInfo,
} from '@micro-harness/core'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Server } from 'bun'
import { SessionStore, type SessionMeta } from './store.ts'

export interface ServerOptions {
  store: SessionStore
  provider: Provider
  /** Model used for new sessions/forks (roles may override later). */
  model: string
  /** Model ids advertised by GET /api/models; defaults to [model]. */
  models?: string[]
  /** Connected MCP servers, for reporting (the tools themselves arrive in `tools`). */
  mcpServers?: McpServerInfo[]
  /** Working directory for the agent's tools. */
  cwd: string
  tools?: Tool[]
  /** Agent roles exposed to the `task` tool (the default "agent" role is always added). */
  roles?: AgentRole[]
  allowBash?: boolean
  approval?: 'suggest' | 'auto-edit' | 'full-auto'
  maxDepth?: number
  maxConcurrency?: number
  agentTimeoutMs?: number
  agentMaxTokens?: number
  /** Run each sub-agent in its own git worktree so parallel edits never collide. */
  isolation?: 'none' | 'worktree'
  maxSteps?: number
  systemPrompt?: string
  pricing?: { input: number; output: number; inputCached?: number }
  /** Cap on a single tool result, in characters (~3k tokens by default). */
  maxToolOutput?: number
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

  /** Worktree info per agent, read back from the durable event stream. */
  const agentWorktrees = (id: string): Map<string, { path: string; branch: string; base: string }> => {
    const map = new Map<string, { path: string; branch: string; base: string }>()
    for (const e of store.events(id)) {
      const ev = e.event
      if (ev.type === 'agent.worktree') map.set(e.agentId, { path: ev.path, branch: ev.branch, base: ev.base })
    }
    return map
  }

  const build = (meta: SessionMeta): SessionRuntime => {
    const hub = new EventHub()
    // Attach persistence *before* the Harness emits its `session.start`.
    const off = hub.on((e: TaggedEvent) => store.append(meta.id, e))
    const sessionModel = meta.model || model
    const sessionCwd = meta.cwd || cwd
    const baseTools = options.tools ?? makeTools()

    // Multi-agent: every session gets its own runner (bound to this session's hub
    // so child-agent events land in the same recorded stream) and the `task` tool.
    const runner = new AgentRunner({
      provider,
      model: sessionModel,
      cwd: sessionCwd,
      hub,
      roles: createAgentRegistry(options.roles ?? []),
      tools: baseTools,
      allowBash: options.allowBash,
      approval: options.approval,
      maxDepth: options.maxDepth,
      maxConcurrency: options.maxConcurrency,
      timeoutMs: options.agentTimeoutMs,
      maxTokens: options.agentMaxTokens,
      isolation: options.isolation,
      pricing: options.pricing,
    })

    const harness = new Harness({
      provider,
      model: sessionModel,
      cwd: sessionCwd,
      tools: [...baseTools, makeTaskTool(runner)],
      hub,
      maxSteps: options.maxSteps,
      systemPrompt: options.systemPrompt,
      pricing: options.pricing,
      maxToolOutput: options.maxToolOutput,
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

  const fork = (id: string, keep?: number): SessionMeta => {
    const source = store.require(id)
    const copy = store.create({
      title: source.title ? `${source.title} (fork)` : '(fork)',
      model: source.model,
      cwd: source.cwd,
      parentId: source.id,
    })
    const events = store.events(id)
    // `keep` truncates the copied transcript; when absent the fork copies everything.
    store.appendAll(copy.id, typeof keep === 'number' ? events.slice(0, keep) : events)
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
        let body: { keep?: number } = {}
        try {
          body = (await req.json()) as typeof body
        } catch {
          /* empty body: fork everything */
        }
        return json({ session: fork(id, body.keep) }, 201)
      }
      // --- isolation / merge queue (P7) ---
      if (action === 'agents') {
        const wts = agentWorktrees(id)
        if (parts[4]) {
          const agentId = decodeURIComponent(parts[4])
          const wt = wts.get(agentId)
          if (!wt) return json({ error: 'agent has no worktree' }, 404)
          const meta = store.require(id)
          if (parts[5] === 'diff' && req.method === 'GET') {
            try {
              return json({ agentId, worktree: wt, ...worktreeDiff(wt.path) })
            } catch (err) {
              return json({ error: String((err as Error).message) }, 500)
            }
          }
          if (parts[5] === 'promote' && req.method === 'POST') {
            try {
              return json(promoteWorktree({ worktree: wt.path, cwd: meta.cwd || cwd }))
            } catch (err) {
              return json({ error: String((err as Error).message) }, 500)
            }
          }
          if (parts[5] === 'cleanup' && req.method === 'POST') {
            try {
              removeWorktree({ cwd: meta.cwd || cwd, path: wt.path, branch: wt.branch })
              return json({ ok: true })
            } catch (err) {
              return json({ error: String((err as Error).message) }, 500)
            }
          }
          if (parts[5] === 'apply' && req.method === 'POST') {
            let body: { hunks?: number[] } = {}
            try {
              body = (await req.json()) as typeof body
            } catch {
              return json({ error: 'invalid JSON body' }, 400)
            }
            const hunks = body.hunks
            if (!Array.isArray(hunks) || hunks.some((h) => !Number.isInteger(h))) {
              return json({ error: 'hunks must be an array of integers' }, 400)
            }
            try {
              const d = worktreeDiff(wt.path)
              const root = meta.cwd || cwd
              const files: Array<{ path: string; content?: string; delete?: boolean; agentId?: string }> = []
              const conflicted: number[] = []
              for (const f of d.files) {
                let base = ''
                try {
                  base = readFileSync(path.join(root, f.path), 'utf8')
                } catch {
                  /* file does not exist yet — empty base */
                }
                const r = applyHunkSelection(base, d.diff, f.path, hunks)
                if (r.applied.length === 0 && r.conflicted.length === 0) continue
                conflicted.push(...r.conflicted)
                files.push(
                  r.deleted
                    ? { path: f.path, delete: true, agentId }
                    : { path: f.path, content: r.content, agentId },
                )
              }
              const result = integrateApply({ cwd: root, worktrees: { [agentId]: wt.path }, files })
              return json({ applied: result.applied, conflicted, backup: result.backup })
            } catch (err) {
              return json({ error: String((err as Error).message) }, 500)
            }
          }
          return json({ error: 'not found' }, 404)
        }
        if (req.method === 'GET') return json({ agents: [...wts.entries()].map(([agentId, w]) => ({ agentId, ...w })) })
        return json({ error: 'method not allowed' }, 405)
      }

      if (action === 'integrate') {
        const meta = store.require(id)
        const wts = agentWorktrees(id)
        if (!wts.size) return json({ error: 'no isolated agents' }, 400)
        if (req.method === 'GET') {
          try {
            const agents = [...wts.entries()].map(([agentId, w]) => ({ agentId, worktree: w.path, base: w.base }))
            return json(integratePreview({ cwd: meta.cwd || cwd, agents }))
          } catch (err) {
            return json({ error: String((err as Error).message) }, 500)
          }
        }
        if (req.method === 'POST') {
          let body: { files?: Array<{ path: string; content?: string; delete?: boolean; takeTheirs?: boolean; agentId?: string }> } = {}
          try {
            body = (await req.json()) as typeof body
          } catch {
            /* empty body */
          }
          const worktrees = Object.fromEntries([...wts.entries()].map(([agentId, w]) => [agentId, w.path]))
          try {
            return json(integrateApply({ cwd: meta.cwd || cwd, worktrees, files: body.files ?? [] }))
          } catch (err) {
            return json({ error: String((err as Error).message) }, 500)
          }
        }
        return json({ error: 'method not allowed' }, 405)
      }

      if (req.method === 'PATCH') {
        if (!store.has(id)) return json({ error: 'session not found' }, 404)
        let body: { title?: string } = {}
        try {
          body = (await req.json()) as typeof body
        } catch {
          /* empty */
        }
        const title = (body.title ?? '').trim()
        if (!title) return json({ error: 'title is required' }, 400)
        return json({ session: store.renameSession(id, title) })
      }
      if (action) return json({ error: 'not found' }, 404)
      if (req.method === 'GET') {
        if (!store.has(id)) return json({ error: 'session not found' }, 404)
        return json({ session: store.require(id), events: store.events(id) })
      }
      if (req.method === 'DELETE') {
        const meta = store.require(id)
        for (const w of agentWorktrees(id).values()) {
          try {
            removeWorktree({ cwd: meta.cwd || cwd, path: w.path, branch: w.branch })
          } catch {
            /* best effort */
          }
        }
        if (!store.delete(id)) return json({ error: 'session not found' }, 404)
        runtimes.delete(id)
        return json({ ok: true })
      }
      return json({ error: 'method not allowed' }, 405)
    }

    // /api/models
    if (parts[0] === 'api' && parts[1] === 'models') {
      if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405)
      const models = options.models && options.models.length ? options.models : [model]
      return json({ models, default: model })
    }

    // /api/mcp
    if (parts[0] === 'api' && parts[1] === 'mcp') {
      if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405)
      return json({ servers: options.mcpServers ?? [] })
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
