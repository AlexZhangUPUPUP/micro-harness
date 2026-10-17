import { test, expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SessionStore } from '../src/store.ts'
import { createServer, type HarnessServer } from '../src/server.ts'
import {
  createWorktree,
  makeTools,
  parseDiff,
  removeWorktree,
  worktreeDiff,
  type ChatMessage,
  type Provider,
} from '@micro-harness/core'
import { createApprovalBroker } from '../src/approvals.ts'
import type { AgentEvent } from '@micro-harness/core'

interface Harness {
  srv: HarnessServer
  store: SessionStore
  dir: string
  seen: ChatMessage[][]
  stop: () => void
}

function lastUser(messages: ChatMessage[]): string {
  const m = [...messages].reverse().find((x) => x.role === 'user')
  return String(m?.content ?? '')
}

function echoProvider(): { provider: Provider; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = []
  return {
    provider: {
      name: 'echo',
      async chat(req) {
        seen.push(req.messages.map((m) => ({ ...m })))
        return { message: { role: 'assistant', content: `echo:${lastUser(req.messages)}` } }
      },
    },
    seen,
  }
}

function boot(overrides: { token?: string; requireAuth?: boolean; models?: string[] } = {}): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-server-'))
  const store = new SessionStore(dir)
  const { provider, seen } = echoProvider()
  const srv = createServer({
    store,
    provider,
    model: 'fake-model',
    cwd: dir,
    requireAuth: overrides.requireAuth ?? false,
    token: overrides.token,
    models: overrides.models,
  })
  return {
    srv,
    store,
    dir,
    seen,
    stop: () => {
      srv.stop(true)
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('health, create, get, list and delete a session', async () => {
  const h = boot()
  try {
    const health = await fetch(`${h.srv.url}/health`)
    expect(health.status).toBe(200)
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true)

    const created = await fetch(`${h.srv.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello server' }),
    })
    expect(created.status).toBe(201)
    const { session } = (await created.json()) as { session: { id: string; title: string } }
    expect(session.title).toBe('hello server')
    await h.srv.idle(session.id)

    const got = await fetch(`${h.srv.url}/api/sessions/${session.id}`)
    const body = (await got.json()) as { session: { status: string }; events: unknown[] }
    expect(body.session.status).toBe('done')
    expect(body.events.length).toBeGreaterThan(2)

    const list = (await (await fetch(`${h.srv.url}/api/sessions`)).json()) as { sessions: unknown[] }
    expect(list.sessions.length).toBe(1)

    const del = await fetch(`${h.srv.url}/api/sessions/${session.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(h.store.get(session.id)).toBeUndefined()
  } finally {
    h.stop()
  }
})

test('SSE stream replays recorded events and terminates', async () => {
  const h = boot()
  try {
    const { session } = (await (
      await fetch(`${h.srv.url}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'stream me' }),
      })
    ).json()) as { session: { id: string } }
    await h.srv.idle(session.id)

    const res = await fetch(`${h.srv.url}/api/sessions/${session.id}/events`)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('"type":"session.start"')
    expect(text).toContain('"type":"user.message"')
    expect(text).toContain('"type":"turn.end"')
    expect(text).toContain('event: end')
    expect(text).toContain('echo:stream me')
  } finally {
    h.stop()
  }
})

test('full-text search finds recorded content', async () => {
  const h = boot()
  try {
    const { session } = (await (
      await fetch(`${h.srv.url}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'refactor the flux capacitor' }),
      })
    ).json()) as { session: { id: string } }
    await h.srv.idle(session.id)

    const res = await fetch(`${h.srv.url}/api/search?q=capacitor`)
    const { hits } = (await res.json()) as { hits: Array<{ sessionId: string }> }
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.sessionId).toBe(session.id)
  } finally {
    h.stop()
  }
})

test('fork copies the transcript into a child session', async () => {
  const h = boot()
  try {
    const { session } = (await (
      await fetch(`${h.srv.url}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'original question' }),
      })
    ).json()) as { session: { id: string } }
    await h.srv.idle(session.id)

    const res = await fetch(`${h.srv.url}/api/sessions/${session.id}/fork`, { method: 'POST' })
    const { session: forked } = (await res.json()) as { session: { id: string; parentId: string } }
    expect(forked.parentId).toBe(session.id)
    expect(h.store.events(forked.id).length).toBe(h.store.events(session.id).length)
    expect(h.store.get(forked.id)?.title).toContain('fork')
  } finally {
    h.stop()
  }
})

test('fork with { keep } truncates the copy, fork without keep copies all', async () => {
  const h = boot()
  try {
    const { session } = (await (
      await fetch(`${h.srv.url}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'truncate me' }),
      })
    ).json()) as { session: { id: string } }
    await h.srv.idle(session.id)

    const total = h.store.events(session.id).length
    expect(total).toBeGreaterThan(2)

    const truncated = await fetch(`${h.srv.url}/api/sessions/${session.id}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keep: 2 }),
    })
    expect(truncated.status).toBe(201)
    const { session: child } = (await truncated.json()) as { session: { id: string } }
    expect(h.store.events(child.id).length).toBe(2)

    const full = await fetch(`${h.srv.url}/api/sessions/${session.id}/fork`, { method: 'POST' })
    const { session: fullChild } = (await full.json()) as { session: { id: string } }
    expect(h.store.events(fullChild.id).length).toBe(total)
  } finally {
    h.stop()
  }
})

test('PATCH /api/sessions/:id renames a session', async () => {
  const h = boot()
  try {
    const { session } = (await (
      await fetch(`${h.srv.url}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'old name' }),
      })
    ).json()) as { session: { id: string } }
    await h.srv.idle(session.id)

    const res = await fetch(`${h.srv.url}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '  new name  ' }),
    })
    expect(res.status).toBe(200)
    const { session: renamed } = (await res.json()) as { session: { title: string } }
    expect(renamed.title).toBe('new name')
    // persisted to disk + sqlite, so a fresh store read agrees
    expect(h.store.get(session.id)?.title).toBe('new name')

    const unknown = await fetch(`${h.srv.url}/api/sessions/nope`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: string }).error).toBe('session not found')

    const blank = await fetch(`${h.srv.url}/api/sessions/${session.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    })
    expect(blank.status).toBe(400)
    expect(((await blank.json()) as { error: string }).error).toBe('title is required')
  } finally {
    h.stop()
  }
})

test('GET /api/models lists configured models and the default', async () => {
  const h = boot({ models: ['a-model', 'b-model'] })
  try {
    const res = await fetch(`${h.srv.url}/api/models`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ models: ['a-model', 'b-model'], default: 'fake-model' })
  } finally {
    h.stop()
  }
})

test('GET /api/models falls back to the single default model', async () => {
  const h = boot()
  try {
    const res = await fetch(`${h.srv.url}/api/models`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ models: ['fake-model'], default: 'fake-model' })
  } finally {
    h.stop()
  }
})

test('resume reconstructs prior context before continuing', async () => {
  const h = boot()
  try {
    const { session } = (await (
      await fetch(`${h.srv.url}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'first turn' }),
      })
    ).json()) as { session: { id: string } }
    await h.srv.idle(session.id)

    const res = await fetch(`${h.srv.url}/api/sessions/${session.id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'second turn' }),
    })
    expect(res.status).toBe(202)
    await h.srv.idle(session.id)

    const resumedCall = h.seen[h.seen.length - 1]!
    expect(resumedCall.some((m) => m.role === 'user' && m.content === 'first turn')).toBe(true)
    expect(resumedCall.some((m) => m.role === 'assistant' && m.content === 'echo:first turn')).toBe(true)
    expect(lastUser(resumedCall)).toBe('second turn')
  } finally {
    h.stop()
  }
})

test('token auth blocks unauthenticated requests and accepts bearer or query token', async () => {
  const h = boot({ token: 'secret-token', requireAuth: true })
  try {
    const denied = await fetch(`${h.srv.url}/api/sessions`)
    expect(denied.status).toBe(401)

    const bearer = await fetch(`${h.srv.url}/api/sessions`, { headers: { Authorization: 'Bearer secret-token' } })
    expect(bearer.status).toBe(200)

    const query = await fetch(`${h.srv.url}/api/sessions?token=secret-token`)
    expect(query.status).toBe(200)

    const wrong = await fetch(`${h.srv.url}/api/sessions?token=nope`)
    expect(wrong.status).toBe(401)
  } finally {
    h.stop()
  }
})

test('binding beyond loopback without a token is refused', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-server-'))
  const store = new SessionStore(dir)
  try {
    const { provider } = echoProvider()
    expect(() => createServer({ store, provider, model: 'm', cwd: dir, hostname: '0.0.0.0' })).toThrow(/token/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session can delegate to a sub-agent through the task tool', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-server-agent-'))
  const store = new SessionStore(dir)
  const provider: Provider = {
    name: 'scripted',
    async chat(req) {
      const hasToolResult = req.messages.some((m) => m.role === 'tool')
      if (lastUser(req.messages).includes('CHILD')) return { message: { role: 'assistant', content: 'CHILD-OK' } }
      if (!hasToolResult) {
        return {
          message: {
            role: 'assistant',
            content: 'delegating',
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ mode: 'single', prompt: 'say CHILD-OK' }) } },
            ],
          },
        }
      }
      return { message: { role: 'assistant', content: 'parent done' } }
    },
  }
  const srv = createServer({ store, provider, model: 'fake', cwd: dir, requireAuth: false })
  try {
    const created = await fetch(`${srv.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'please delegate' }),
    })
    const { session } = (await created.json()) as { session: { id: string } }
    await srv.idle(session.id)

    const body = (await (await fetch(`${srv.url}/api/sessions/${session.id}`)).json()) as {
      events: Array<{ agentId: string; event: { type: string; name?: string; ok?: boolean; text?: string } }>
    }
    const task = body.events.find((e) => e.event.type === 'tool.result' && e.event.name === 'task')
    expect(task?.event.ok).toBe(true)
    expect(body.events.some((e) => e.agentId !== 'main')).toBe(true)
    expect(body.events.some((e) => e.event.type === 'turn.end' && (e.event.text ?? '').includes('parent done'))).toBe(true)
  } finally {
    srv.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isolation over HTTP: worktree, diff, promote and the merge queue', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-server-iso-'))
  const sessions = mkdtempSync(path.join(tmpdir(), 'mh-server-iso-sessions-'))
  const git = (...a: string[]): void => void execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(path.join(dir, 'base.txt'), 'base\n')
  git('add', '-A')
  git('commit', '-qm', 'init')

  const store = new SessionStore(sessions)
  const provider: Provider = {
    name: 'scripted',
    async chat(req) {
      const user = lastUser(req.messages)
      const hasToolResult = req.messages.some((m) => m.role === 'tool')
      if (user.includes('delegate')) {
        if (!hasToolResult) {
          return {
            message: {
              role: 'assistant',
              content: 'delegating',
              tool_calls: [
                { id: 't1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ mode: 'single', prompt: 'create marker.txt' }) } },
              ],
            },
          }
        }
        return { message: { role: 'assistant', content: 'parent done' } }
      }
      if (!hasToolResult) {
        return {
          message: {
            role: 'assistant',
            content: 'writing',
            tool_calls: [
              { id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'marker.txt', content: 'hi\n' }) } },
            ],
          },
        }
      }
      return { message: { role: 'assistant', content: 'child done' } }
    },
  }
  const srv = createServer({ store, provider, model: 'fake', cwd: dir, requireAuth: false, isolation: 'worktree' })
  try {
    const created = await fetch(`${srv.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'please delegate' }),
    })
    const { session } = (await created.json()) as { session: { id: string } }
    await srv.idle(session.id)

    const agents = (await (await fetch(`${srv.url}/api/sessions/${session.id}/agents`)).json()) as {
      agents: Array<{ agentId: string; path: string; branch: string }>
    }
    expect(agents.agents.length).toBeGreaterThan(0)
    const agentId = agents.agents[0]!.agentId

    const diff = (await (
      await fetch(`${srv.url}/api/sessions/${session.id}/agents/${encodeURIComponent(agentId)}/diff`)
    ).json()) as { files: Array<{ path: string }> }
    expect(diff.files.map((f) => f.path)).toContain('marker.txt')
    // isolated: the shared workspace is untouched until we promote
    expect(existsSync(path.join(dir, 'marker.txt'))).toBe(false)

    const promoted = (await (
      await fetch(`${srv.url}/api/sessions/${session.id}/agents/${encodeURIComponent(agentId)}/promote`, { method: 'POST' })
    ).json()) as { ok: boolean }
    expect(promoted.ok).toBe(true)
    expect(existsSync(path.join(dir, 'marker.txt'))).toBe(true)

    const integrate = (await (await fetch(`${srv.url}/api/sessions/${session.id}/integrate`)).json()) as { files: unknown[] }
    expect(Array.isArray(integrate.files)).toBe(true)

    // DELETE also cleans the worktrees up
    await fetch(`${srv.url}/api/sessions/${session.id}`, { method: 'DELETE' })
    expect(existsSync(agents.agents[0]!.path)).toBe(false)
  } finally {
    srv.stop(true)
    rmSync(dir, { recursive: true, force: true })
    rmSync(sessions, { recursive: true, force: true })
  }
})

/** A temp git repo + real worktree whose agent modified `base.txt` in two hunks. */
function applyWorktree(): {
  srv: HarnessServer
  store: SessionStore
  dir: string
  sessions: string
  sessionId: string
  agentId: string
  wt: { path: string; branch: string; base: string }
  stop: () => void
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-server-apply-'))
  const sessions = mkdtempSync(path.join(tmpdir(), 'mh-server-apply-sessions-'))
  const git = (...a: string[]): void => void execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 't@t')
  git('config', 'user.name', 't')
  git('config', 'commit.gpgsign', 'false')
  const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`)
  writeFileSync(path.join(dir, 'base.txt'), lines.join('\n') + '\n')
  git('add', '-A')
  git('commit', '-qm', 'init')

  const store = new SessionStore(sessions)
  const srv = createServer({ store, provider: echoProvider().provider, model: 'fake', cwd: dir, requireAuth: false })
  const meta = store.create({ cwd: dir })
  const wt = createWorktree({ cwd: dir, taskId: 'apply', agentId: 'child-1' })
  const changed = [...lines]
  changed[1] = 'LINE-2-CHANGED'
  changed[18] = 'LINE-19-CHANGED'
  writeFileSync(path.join(wt.path, 'base.txt'), changed.join('\n') + '\n')
  // The server reads worktrees back from the durable event stream.
  store.append(meta.id, {
    agentId: 'child-1',
    parentId: 'main',
    seq: 1,
    t: Date.now(),
    event: { type: 'agent.worktree', path: wt.path, branch: wt.branch, base: wt.base },
  })
  return {
    srv,
    store,
    dir,
    sessions,
    sessionId: meta.id,
    agentId: 'child-1',
    wt,
    stop: () => {
      srv.stop(true)
      try {
        removeWorktree({ cwd: dir, path: wt.path, branch: wt.branch })
      } catch {
        /* best effort */
      }
      rmSync(dir, { recursive: true, force: true })
      rmSync(sessions, { recursive: true, force: true })
    },
  }
}

test('apply 404s when the agent has no worktree', async () => {
  const h = boot()
  try {
    const meta = h.store.create({ cwd: h.dir })
    const res = await fetch(`${h.srv.url}/api/sessions/${meta.id}/agents/nope/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hunks: [0] }),
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('agent has no worktree')
  } finally {
    h.stop()
  }
})

test('apply 400s on a missing/invalid hunks body', async () => {
  const w = applyWorktree()
  try {
    const url = `${w.srv.url}/api/sessions/${w.sessionId}/agents/${w.agentId}/apply`
    for (const body of [undefined, 'not json', {}, { hunks: 'nope' }, { hunks: [0, 'x'] }]) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      })
      expect(res.status).toBe(400)
      const { error } = (await res.json()) as { error: string }
      expect(error).toMatch(/hunks|invalid JSON/i)
    }
  } finally {
    w.stop()
  }
})

test('apply: the accepted hunk lands on disk and the rejected hunk stays', async () => {
  const w = applyWorktree()
  try {
    const d = worktreeDiff(w.wt.path)
    expect(d.files.map((f) => f.path)).toContain('base.txt')
    const hunks = parseDiff(d.diff).hunks.filter((h) => h.file === 'base.txt')
    expect(hunks.length).toBe(2)
    const bottom = hunks.find((h) => h.newLines.includes('LINE-19-CHANGED'))
    expect(bottom).toBeDefined()

    const res = await fetch(`${w.srv.url}/api/sessions/${w.sessionId}/agents/${w.agentId}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hunks: [bottom!.index] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { applied: string[]; conflicted: number[]; backup: string | null }
    expect(body.applied).toContain('base.txt')
    expect(body.conflicted).toEqual([])
    expect(body.backup).toBeTruthy()

    const after = readFileSync(path.join(w.dir, 'base.txt'), 'utf8').split('\n')
    expect(after[1]).toBe('line-2') // rejected top hunk untouched
    expect(after[18]).toBe('LINE-19-CHANGED') // accepted bottom hunk applied
  } finally {
    w.stop()
  }
})

/* ------------------------------------------ approvals & multimodal prompts */

test('an approval-required tool waits for the client and honours the answer', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-approve-'))
  try {
    const store = new SessionStore(dir)
    // a provider that asks for a mutating tool call, then finishes
    const replies: Array<() => unknown> = [
      () => ({
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"x.txt","content":"hi"}' } }],
        },
      }),
      () => ({ message: { role: 'assistant', content: 'done' } }),
      () => ({ message: { role: 'assistant', content: 'done' } }),
    ]
    let i = 0
    const provider: Provider = { name: 'scripted', async chat() { return replies[Math.min(i++, replies.length - 1)]!() as never } }
    const approvals = createApprovalBroker({ timeoutMs: 5000 })
    const srv = createServer({ store, provider, model: 'fake', cwd: dir, requireAuth: false, approval: 'suggest', approvals })

    const created = await (await fetch(`${srv.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'write x.txt', title: 'needs approval' }),
    })).json()
    const id = created.session.id

    // wait for the permission request to appear on the event stream
    let request: Extract<AgentEvent, { type: 'permission.request' }> | undefined
    for (let n = 0; n < 60 && !request; n++) {
      await new Promise((r) => setTimeout(r, 50))
      request = store
        .events(id)
        .map((e) => e.event)
        .find((e): e is Extract<AgentEvent, { type: 'permission.request' }> => e.type === 'permission.request')
    }
    expect(request).toBeDefined()
    expect(existsSync(path.join(dir, 'x.txt'))).toBe(false) // the tool has not run yet
    expect(approvals.pending().length).toBe(1)

    // answer → the tool runs
    const res = await fetch(`${srv.url}/api/sessions/${id}/permissions/${request!.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allow: true }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    for (let n = 0; n < 60; n++) {
      await new Promise((r) => setTimeout(r, 50))
      if (readFileSync(path.join(dir, 'x.txt'), 'utf8').includes('hi')) break
    }
    expect(readFileSync(path.join(dir, 'x.txt'), 'utf8')).toBe('hi')
    const decided = store.events(id).map((e) => e.event).find((e) => e.type === 'permission.result')
    expect(decided && 'decision' in decided ? decided.decision : '').toBe('allow')

    // answering twice (or an unknown id) is a 404, not a crash
    const again = await fetch(`${srv.url}/api/sessions/${id}/permissions/${request!.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allow: false }),
    })
    expect(again.status).toBe(404)
    srv.stop(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a denied approval stops the tool and is reported as such', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-deny-'))
  try {
    const store = new SessionStore(dir)
    const replies = [
      { message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"y.txt","content":"nope"}' } }] } },
      { message: { role: 'assistant', content: 'ok' } },
      { message: { role: 'assistant', content: 'ok' } },
    ]
    let i = 0
    const provider: Provider = { name: 'scripted', async chat() { return replies[Math.min(i++, replies.length - 1)]! as never } }
    const approvals = createApprovalBroker({ timeoutMs: 5000 })
    const srv = createServer({ store, provider, model: 'fake', cwd: dir, requireAuth: false, approval: 'suggest', approvals })
    const created = await (await fetch(`${srv.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'write y.txt' }),
    })).json()
    const id = created.session.id
    let request: Extract<AgentEvent, { type: 'permission.request' }> | undefined
    for (let n = 0; n < 60 && !request; n++) {
      await new Promise((r) => setTimeout(r, 50))
      request = store.events(id).map((e) => e.event).find((e): e is Extract<AgentEvent, { type: 'permission.request' }> => e.type === 'permission.request')
    }
    await fetch(`${srv.url}/api/sessions/${id}/permissions/${request!.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allow: false }),
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(existsSync(path.join(dir, 'y.txt'))).toBe(false)
    const result = store.events(id).map((e) => e.event).find((e) => e.type === 'tool.result')
    expect(result && 'ok' in result ? result.ok : true).toBe(false)
    srv.stop(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('images on a prompt reach the provider as multimodal content parts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-img-'))
  try {
    const store = new SessionStore(dir)
    const { provider, seen } = echoProvider()
    const srv = createServer({ store, provider, model: 'fake', cwd: dir, requireAuth: false })
    const created = await (await fetch(`${srv.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'what is this?', images: [{ mimeType: 'image/png', data: 'AAAA' }] }),
    })).json()
    expect(created.session.id).toBeTruthy()
    for (let n = 0; n < 40 && seen.length === 0; n++) await new Promise((r) => setTimeout(r, 25))
    const user = seen[0]?.find((m) => m.role === 'user')
    expect(Array.isArray(user?.content)).toBe(true)
    const parts = user!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>
    expect(parts[0]).toEqual({ type: 'text', text: 'what is this?' })
    expect(parts[1]?.image_url?.url).toBe('data:image/png;base64,AAAA')
    srv.stop(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('permission presets gate the built-in tool set', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-perm-'))
  const store = new SessionStore(dir)
  const seen: string[][] = []
  const provider: Provider = {
    name: 'tools',
    async chat(req) {
      seen.push(req.tools.map((t) => String(t.function?.name ?? '')))
      return { message: { role: 'assistant', content: 'ok' } }
    },
  }
  const srv = createServer({ store, provider, model: 'fake', cwd: dir, requireAuth: false, permission: 'read-only' })
  try {
    const created = await fetch(`${srv.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    })
    const { session } = (await created.json()) as { session: { id: string } }
    await srv.idle(session.id)
    expect(seen[0]).toContain('read_file')
    expect(seen[0]).toContain('list_dir')
    expect(seen[0]).not.toContain('write_file')
    expect(seen[0]).not.toContain('bash')

    // Widen just this session; the next run picks the new preset up.
    const res = await fetch(`${srv.url}/api/sessions/${session.id}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'full' }),
    })
    expect(res.status).toBe(200)
    await fetch(`${srv.url}/api/sessions/${session.id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'again' }),
    })
    await srv.idle(session.id)
    expect(seen[1]).toContain('write_file')
    expect(seen[1]).toContain('bash')

    const perm = (await (await fetch(`${srv.url}/api/permission?session=${session.id}`)).json()) as { session: string }
    expect(perm.session).toBe('full')
  } finally {
    srv.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session can switch its model for the next run', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-model-'))
  const store = new SessionStore(dir)
  const { provider } = echoProvider()
  const srv = createServer({
    store,
    provider,
    model: 'model-a',
    cwd: dir,
    requireAuth: false,
    models: ['model-a', 'model-b'],
  })
  try {
    const list = (await (await fetch(`${srv.url}/api/models`)).json()) as { models: string[]; default: string }
    expect(list.models).toEqual(['model-a', 'model-b'])

    const created = await fetch(`${srv.url}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    })
    const { session } = (await created.json()) as { session: { id: string } }
    await srv.idle(session.id)

    const res = await fetch(`${srv.url}/api/sessions/${session.id}/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'model-b' }),
    })
    expect(res.status).toBe(200)
    expect(store.require(session.id).model).toBe('model-b')
  } finally {
    srv.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('permission presets gate network tools', async () => {
  const netTool = {
    name: 'web__demo',
    description: 'network',
    parameters: { type: 'object', properties: {} },
    network: true,
    run: async () => ({ output: 'ok' }),
  }
  for (const [preset, expected] of [
    ['read-only', false],
    ['workspace', false],
    ['full', true],
  ] as const) {
    const dir = mkdtempSync(path.join(tmpdir(), 'mh-net-'))
    const store = new SessionStore(dir)
    const seen: string[][] = []
    const provider: Provider = {
      name: 't',
      async chat(req) {
        seen.push(req.tools.map((t) => String(t.function?.name ?? '')))
        return { message: { role: 'assistant', content: 'ok' } }
      },
    }
    const srv = createServer({
      store,
      provider,
      model: 'fake',
      cwd: dir,
      requireAuth: false,
      permission: preset,
      tools: [...makeTools(), netTool],
    })
    try {
      const created = await fetch(`${srv.url}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' }),
      })
      const { session } = (await created.json()) as { session: { id: string } }
      await srv.idle(session.id)
      expect(seen[0]!.includes('web__demo')).toBe(expected)
    } finally {
      srv.stop(true)
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('/api/web reports and flips the runtime toggle', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-web-'))
  const toggle = path.join(dir, 'web.json')
  const prev = process.env.MICRO_WEB_TOGGLE_FILE
  process.env.MICRO_WEB_TOGGLE_FILE = toggle
  const store = new SessionStore(dir)
  const { provider } = echoProvider()
  const srv = createServer({ store, provider, model: 'fake', cwd: dir, requireAuth: false })
  try {
    const before = (await (await fetch(`${srv.url}/api/web`)).json()) as { enabled: boolean }
    expect(before.enabled).toBe(true)
    const res = await fetch(`${srv.url}/api/web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
    const after = (await (await fetch(`${srv.url}/api/web`)).json()) as { enabled: boolean }
    expect(after.enabled).toBe(false)
    expect((JSON.parse(readFileSync(toggle, 'utf8')) as { enabled: boolean }).enabled).toBe(false)

    // Provider selection lives in the same file; flipping it keeps `enabled`.
    const listed = (await (await fetch(`${srv.url}/api/web`)).json()) as {
      providers: Array<{ id: string; configured: boolean }>
    }
    expect(listed.providers.map((p) => p.id)).toEqual(['bing', 'bocha', 'baidu', 'searxng'])
    expect(listed.providers.find((p) => p.id === 'bing')?.configured).toBe(true)

    const pick = await fetch(`${srv.url}/api/web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'bing' }),
    })
    expect(pick.status).toBe(200)
    const state = (await (await fetch(`${srv.url}/api/web`)).json()) as { enabled: boolean; provider: string }
    expect(state.provider).toBe('bing')
    expect(state.enabled).toBe(false) // preserved from the earlier flip
    expect(JSON.parse(readFileSync(toggle, 'utf8'))).toEqual({ enabled: false, provider: 'bing' })

    const unknown = await fetch(`${srv.url}/api/web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'nope' }),
    })
    expect(unknown.status).toBe(400)
  } finally {
    srv.stop(true)
    if (prev === undefined) delete process.env.MICRO_WEB_TOGGLE_FILE
    else process.env.MICRO_WEB_TOGGLE_FILE = prev
    rmSync(dir, { recursive: true, force: true })
  }
})
