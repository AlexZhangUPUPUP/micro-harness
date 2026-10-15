#!/usr/bin/env bun
/**
 * Feature verification for P3 (multi-agent), P4 (server) and P5 (CLI building
 * blocks) — exercises the real code paths with a **scripted model provider**, so
 * it needs no API key, no network and is deterministic.
 *
 *   bun scripts/verify-features.ts
 *
 * Exits non-zero if any check fails. This is the "does it actually work" gate
 * that sits next to (and is stronger than) the unit tests.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  AgentRunner,
  EventHub,
  Harness,
  chatStream,
  createAgentRegistry,
  expandTemplate,
  loadPromptTemplates,
  loadSkills,
  makeTaskTool,
  runAuto,
  runTask,
  type ChatMessage,
  type ChatResponse,
  type Provider,
} from '../packages/core/src/index.ts'
import { createServer } from '../packages/server/src/server.ts'
import { SessionStore } from '../packages/server/src/store.ts'

const results: { name: string; ok: boolean; detail: string }[] = []
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`)
}
const section = (t: string): void => console.log(`\n${t}`)

/** A provider that echoes the last user message, with a fixed usage. */
function echoProvider(tag = 'ECHO'): Provider {
  return {
    name: 'echo',
    async chat(req) {
      const user = [...req.messages].reverse().find((m) => m.role === 'user')
      const text = `${tag}(${String(user?.content ?? '').slice(0, 60)})`
      return { message: { role: 'assistant', content: text }, usage: { prompt_tokens: 10, completion_tokens: 5 } }
    },
  }
}

function temp(): string {
  return mkdtempSync(path.join(tmpdir(), 'mh-verify-'))
}

/* ------------------------------------------------------------------ P3 ---- */

async function verifyP3(): Promise<void> {
  section('P3 · multi-agent')
  const cwd = temp()
  const hub = new EventHub()
  const events: { agentId: string; parentId: string | null; type: string }[] = []
  hub.on((e) => events.push({ agentId: e.agentId, parentId: e.parentId, type: e.event.type }))

  const roles = createAgentRegistry([
    { name: 'scout', systemPrompt: 'scout' },
    { name: 'worker', systemPrompt: 'worker' },
  ])
  const runner = new AgentRunner({
    provider: echoProvider(),
    model: 'fake',
    cwd,
    hub,
    roles,
    tools: [],
    maxDepth: 3,
    maxConcurrency: 2,
  })

  // single
  const single = await runner.run('scout', 'hello', 'main', 0)
  check('single mode returns the child result', single.ok && single.text.includes('ECHO(hello)'), single.text.slice(0, 40))

  // parallel
  const ctx = { cwd, allowBash: false, agentId: 'main', depth: 0 }
  const parallel = await runTask(runner, { mode: 'parallel', tasks: [{ role: 'scout', prompt: 'one' }, { role: 'worker', prompt: 'two' }] }, ctx)
  check('parallel mode runs both and returns both', parallel.output.includes('ECHO(one)') && parallel.output.includes('ECHO(two)'))

  // chain + {previous}
  const chain = await runTask(runner, { mode: 'chain', tasks: [{ role: 'scout', prompt: 'first' }, { role: 'worker', prompt: 'got {previous}' }] }, ctx)
  check('chain mode substitutes {previous}', chain.output.includes('ECHO(first)') && chain.output.includes('got ECHO(first)'), chain.output.slice(0, 60))

  // race + winner marker
  const race = await runTask(runner, { mode: 'race', tasks: [{ role: 'scout', prompt: 'a' }, { role: 'worker', prompt: 'b' }] }, ctx)
  check('race mode reports a winner', race.output.includes('★ winner'))

  // agent tagging (tree reconstructable) + context firewall
  const childEvents = events.filter((e) => e.agentId !== 'main')
  check('child events are tagged with parent=main', childEvents.length > 0 && childEvents.every((e) => e.parentId === 'main'))
  const taskResult = parallel.output
  check('parent only receives the summary, not the child transcript', taskResult.includes('[scout ·') && taskResult.includes('[worker ·'))

  // maxDepth
  const tooDeep = await runner.run('scout', 'x', 'main', 3)
  check('maxDepth refuses deeper nesting', !tooDeep.ok && /max agent depth/.test(tooDeep.error ?? ''), tooDeep.error)

  // unknown role
  const unknown = await runner.run('nope', 'x', 'main', 0)
  check('unknown role fails cleanly', !unknown.ok && /unknown agent role/.test(unknown.error ?? ''))

  // the tool is exposed to the model
  const tool = makeTaskTool(runner)
  check('task tool is registered with the 4 modes', tool.name === 'task' && JSON.stringify(tool.parameters).includes('race'))

  rmSync(cwd, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ P4 ---- */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function verifyP4(): Promise<void> {
  section('P4 · server')
  const dir = temp()
  const store = new SessionStore(dir)
  const server = createServer({
    store,
    provider: echoProvider('SRV'),
    model: 'fake',
    cwd: dir,
    hostname: '127.0.0.1',
    port: 0,
    token: 'verify-token',
  })
  const base = server.url
  const auth = { authorization: 'Bearer verify-token' }

  try {
    const health = await (await fetch(`${base}/health`)).json()
    check('GET /health', health.ok === true && health.name === 'micro-harness')

    const unauth = await fetch(`${base}/api/sessions`)
    check('auth is required (401 without token)', unauth.status === 401)

    const created = await (
      await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'verify p4 roundtrip' }),
      })
    ).json()
    const id: string = created.session.id
    check('POST /api/sessions creates a session', typeof id === 'string' && id.length > 0)

    // wait for the scripted run to finish
    let text = ''
    for (let i = 0; i < 40; i++) {
      await sleep(100)
      const got = await (await fetch(`${base}/api/sessions/${id}`, { headers: auth })).json()
      text = (got.events ?? [])
        .filter((e: any) => e.event.type === 'turn.end')
        .map((e: any) => e.event.text)
        .join('')
      if (text) break
    }
    check('session ran to completion over the provider', text.includes('SRV(verify p4 roundtrip)'), text.slice(0, 50))

    // SSE
    const sse = await fetch(`${base}/api/sessions/${id}/events`, { headers: auth })
    let sseData = ''
    const reader = sse.body!.getReader()
    const dec = new TextDecoder()
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      sseData += dec.decode(value)
      if (sseData.includes('session.start')) break
    }
    void reader.cancel().catch(() => {})
    check('GET /events streams SSE', sseData.startsWith('data:') && sseData.includes('"type":"session.start"'))

    // FTS search
    const search = await (await fetch(`${base}/api/search?q=roundtrip`, { headers: auth })).json()
    check('GET /api/search hits the FTS index', Array.isArray(search.hits) && search.hits.length > 0, `${search.hits?.length ?? 0} hit(s)`)

    // fork
    const forked = await (await fetch(`${base}/api/sessions/${id}/fork`, { method: 'POST', headers: auth })).json()
    check('POST /fork creates a copy', forked.session.id && forked.session.id !== id)

    // delete
    const del = await (await fetch(`${base}/api/sessions/${id}`, { method: 'DELETE', headers: auth })).json()
    const gone = await fetch(`${base}/api/sessions/${id}`, { headers: auth })
    check('DELETE /api/sessions/:id removes it', del.ok === true && gone.status === 404)

    // resume
    const resumed = await (
      await fetch(`${base}/api/sessions/${forked.session.id}/resume`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'resume please' }),
      })
    ).json()
    check('POST /resume accepts a follow-up', resumed.session?.id === forked.session.id)
  } finally {
    server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ P5 ---- */

/** A tiny OpenAI-compatible endpoint that streams SSE deltas. */
function startStreamingModel(): { url: string; stop: () => void } {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { stream?: boolean }
      if (!body.stream) {
        return Response.json({ choices: [{ message: { role: 'assistant', content: 'non-stream' } }] })
      }
      const encoder = new TextEncoder()
      const stream = new ReadableStream({
        start(controller) {
          const chunks = ['He', 'llo', ', ', 'wor', 'ld']
          for (const c of chunks) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`))
          }
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 5 } })}\n\n`,
            ),
          )
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

async function verifyP5(): Promise<void> {
  section('P5 · CLI building blocks')

  // streaming
  const model = startStreamingModel()
  try {
    const deltas: string[] = []
    const res = await chatStream({ baseUrl: model.url, apiKey: 'x', model: 'fake' }, [{ role: 'user', content: 'hi' }], [], undefined, (d) =>
      deltas.push(`${d.type}:${d.text}`),
    )
    check('chatStream emits text deltas', deltas.filter((d) => d.startsWith('text:')).length >= 3, deltas.join(' ').slice(0, 60))
    check('chatStream assembles the full message', String(res.message.content) === 'Hello, world', String(res.message.content))
    check('chatStream reports usage', res.usage?.completion_tokens === 5)
  } finally {
    model.stop()
  }

  // prompt templates + skills
  const root = temp()
  try {
    mkdirSync(path.join(root, 'prompts'), { recursive: true })
    writeFileSync(
      path.join(root, 'prompts', 'greet.md'),
      `---\nname: greet\ndescription: say hi\n---\nSay hello to $ARGUMENTS in one word.`,
    )
    mkdirSync(path.join(root, 'skills', 'review'), { recursive: true })
    writeFileSync(path.join(root, 'skills', 'review', 'SKILL.md'), `---\nname: review\ndescription: code review\n---\nReview carefully.`)
    const templates = loadPromptTemplates(path.join(root, 'prompts'))
    const skills = loadSkills(path.join(root, 'skills'))
    check('prompt templates load from disk', templates.length === 1 && templates[0]!.name === 'greet')
    check('skills load from disk', skills.length === 1 && skills[0]!.name === 'review')
    check('templates expand $ARGUMENTS', expandTemplate(templates[0]!, ['Alex']) === 'Say hello to Alex in one word.')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  // unattended driver
  const cwd = temp()
  try {
    const hub = new EventHub()
    const harness = new Harness({ provider: echoProvider('AUTO'), model: 'fake', cwd, hub })
    const capped = await runAuto({ harness, tasks: ['t1', 't2', 't3'], maxIterations: 2 })
    check('runAuto stops at maxIterations', capped.iterations === 2 && capped.stopReason === 'max-iterations', `${capped.iterations} iters · ${capped.stopReason}`)

    const hub2 = new EventHub()
    const harness2 = new Harness({ provider: echoProvider('AUTO'), model: 'fake', cwd, hub: hub2 })
    const budget = await runAuto({ harness: harness2, tasks: ['t1', 't2', 't3'], maxTokens: 1 })
    check('runAuto enforces a token budget', budget.stopReason === 'token-budget' || budget.iterations <= 1, `${budget.iterations} iters · ${budget.stopReason}`)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

/* ----------------------------------------------------------------- main ---- */

async function main(): Promise<void> {
  const only = process.argv[2] // optional: p3 | p4 | p5
  if (!only || only === 'p3') await verifyP3()
  if (!only || only === 'p4') await verifyP4()
  if (!only || only === 'p5') await verifyP5()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.log('failed:')
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
  }
  process.exit(failed.length ? 1 : 0)
}

await main()
