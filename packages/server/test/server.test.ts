import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SessionStore } from '../src/store.ts'
import { createServer, type HarnessServer } from '../src/server.ts'
import type { ChatMessage, Provider } from '@micro-harness/core'

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

function boot(overrides: { token?: string; requireAuth?: boolean } = {}): Harness {
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
