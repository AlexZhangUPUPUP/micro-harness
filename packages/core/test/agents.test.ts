import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Harness } from '../src/harness.ts'
import { EventHub, buildAgentTree, formatAgentTree, type TaggedEvent } from '../src/events.ts'
import { makeTools } from '../src/tools.ts'
import {
  AgentRunner,
  createAgentRegistry,
  makeTaskTool,
  parseAgentMarkdown,
  runTask,
  type AgentRole,
} from '../src/agents.ts'
import type { ChatRequest, ChatResponse, Provider } from '../src/provider.ts'
import type { ChatMessage, ToolCall } from '../src/model.ts'

const assistantTool = (id: string, name: string, args: unknown): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
})

const call = (name: string, args: unknown): ChatResponse => ({ message: assistantTool('c' + Math.random().toString(36).slice(2), name, args) })

/** Route model calls by a marker in the system prompt (MAIN vs CHILD). */
function router(handlers: { MAIN: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>; CHILD: (req: ChatRequest) => ChatResponse | Promise<ChatResponse> }): Provider {
  return {
    name: 'router',
    async chat(req) {
      const sys = String(req.messages[0]?.content ?? '')
      return sys.includes('MAIN') ? handlers.MAIN(req) : handlers.CHILD(req)
    },
  }
}

function childText(req: ChatRequest): string {
  const last = [...req.messages].reverse().find((m) => m.role === 'user')
  return `out:${String(last?.content ?? '')}`
}

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mh-agents-'))
}

function makeRunner(dir: string, provider: Provider, opts: Partial<ConstructorParameters<typeof AgentRunner>[0]> = {}) {
  const hub = new EventHub()
  const events: TaggedEvent[] = []
  hub.on((e) => events.push(e))
  const runner = new AgentRunner({
    provider,
    model: 'fake',
    cwd: dir,
    hub,
    roles: createAgentRegistry([{ name: 'worker', systemPrompt: 'CHILD worker' }]),
    tools: makeTools(),
    pricing: { input: 1, output: 2 },
    ...opts,
  })
  return { runner, hub, events }
}

test('single mode runs a child and keeps its transcript out of the parent context', async () => {
  const dir = await sandbox()
  try {
    let mainCalls = 0
    const provider = router({
      MAIN: () => {
        mainCalls++
        return mainCalls === 1
          ? call('task', { mode: 'single', role: 'worker', prompt: 'research' })
          : { message: { role: 'assistant', content: 'parent done' } }
      },
      CHILD: () => {
        // The child does work and emits a secret intermediate value.
        if (!childState.started) {
          childState.started = true
          return { message: assistantTool('w', 'write_file', { path: 'child.txt', content: 'CHILD-SECRET' }) }
        }
        return { message: { role: 'assistant', content: 'child-answer' }, usage: { prompt_tokens: 10, completion_tokens: 5 } }
      },
    })
    const childState = { started: false }
    const { runner, hub, events } = makeRunner(dir, provider)
    const harness = new Harness({
      provider,
      model: 'fake',
      cwd: dir,
      systemPrompt: 'MAIN orchestrator',
      agentId: 'main',
      hub,
      tools: [...makeTools(), makeTaskTool(runner)],
    })

    const answer = await harness.send('go')
    expect(answer).toBe('parent done')

    // Firewall: the parent only sees the result text, never the child transcript.
    const serialized = JSON.stringify(harness.messages)
    expect(serialized).toContain('child-answer')
    expect(serialized).not.toContain('CHILD-SECRET')

    // Tree: one root with exactly one child, and cost is attributed to the child.
    const roots = buildAgentTree(events)
    expect(roots.length).toBe(1)
    expect(roots[0]!.agentId).toBe('main')
    expect(roots[0]!.children.length).toBe(1)
    const child = roots[0]!.children[0]!
    expect(child.parentId).toBe('main')
    expect(child.status).toBe('done')
    expect(child.input).toBe(10)
    expect(child.output).toBe(5)
    expect(child.cost).toBeCloseTo((10 / 1e6) * 1 + (5 / 1e6) * 2, 12)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parallel mode runs both tasks and reports both results', async () => {
  const dir = await sandbox()
  try {
    let mainCalls = 0
    const provider = router({
      MAIN: () => {
        mainCalls++
        return mainCalls === 1
          ? call('task', { mode: 'parallel', tasks: [{ role: 'worker', prompt: 'alpha' }, { role: 'worker', prompt: 'beta' }] })
          : { message: { role: 'assistant', content: 'parent done' } }
      },
      CHILD: (req) => ({ message: { role: 'assistant', content: childText(req) } }),
    })
    const { runner, hub, events } = makeRunner(dir, provider)
    const harness = new Harness({
      provider,
      model: 'fake',
      cwd: dir,
      systemPrompt: 'MAIN',
      agentId: 'main',
      hub,
      tools: [...makeTools(), makeTaskTool(runner)],
    })
    await harness.send('go')

    const toolResult = events.find((e) => e.event.type === 'tool.result' && e.event.name === 'task')
    expect(toolResult && 'output' in toolResult.event ? toolResult.event.output : '').toContain('out:alpha')
    expect(toolResult && 'output' in toolResult.event ? toolResult.event.output : '').toContain('out:beta')
    expect(buildAgentTree(events)[0]!.children.length).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('chain mode substitutes {previous} with the prior result', async () => {
  const dir = await sandbox()
  try {
    const seen: string[] = []
    let mainCalls = 0
    const provider = router({
      MAIN: () => {
        mainCalls++
        return mainCalls === 1
          ? call('task', { mode: 'chain', tasks: [{ prompt: 'first' }, { prompt: 'second after {previous}' }] })
          : { message: { role: 'assistant', content: 'done' } }
      },
      CHILD: (req) => {
        const last = [...req.messages].reverse().find((m) => m.role === 'user')
        seen.push(String(last?.content ?? ''))
        return { message: { role: 'assistant', content: `out:${String(last?.content ?? '')}` } }
      },
    })
    const { runner } = makeRunner(dir, provider)
    const result = await runTask(runner, { mode: 'chain', tasks: [{ prompt: 'first' }, { prompt: 'second after {previous}' }] }, { cwd: dir, allowBash: false, agentId: 'main', depth: 0 })
    expect(result.isError).toBeFalsy()
    expect(seen[1]).toBe('second after out:first')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('race mode returns every result and marks the fastest as winner', async () => {
  const dir = await sandbox()
  try {
    const provider = router({
      MAIN: () => ({ message: { role: 'assistant', content: 'noop' } }),
      CHILD: async (req) => {
        const fast = childText(req).includes('fast')
        await new Promise((r) => setTimeout(r, fast ? 5 : 40))
        return { message: { role: 'assistant', content: childText(req) } }
      },
    })
    const { runner } = makeRunner(dir, provider)
    const result = await runTask(runner, { mode: 'race', tasks: [{ prompt: 'fast' }, { prompt: 'slow' }] }, { cwd: dir, allowBash: false, agentId: 'main', depth: 0 })
    expect(result.output).toContain('out:fast')
    expect(result.output).toContain('out:slow')
    // exactly one winner star, on the fast one
    expect((result.output.match(/★ winner/g) ?? []).length).toBe(1)
    expect(result.output).toMatch(/★ winner\nout:fast/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('refuses to exceed maxDepth', async () => {
  const dir = await sandbox()
  try {
    const { runner } = makeRunner(dir, router({ MAIN: () => ({ message: { role: 'assistant', content: 'x' } }), CHILD: () => ({ message: { role: 'assistant', content: 'x' } }) }), { maxDepth: 1 })
    const result = await runner.run('worker', 'deep', 'main', 1)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('max agent depth')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a concurrency limit keeps parallel children serialized', async () => {
  const dir = await sandbox()
  try {
    let active = 0
    let maxActive = 0
    const provider: Provider = {
      name: 'counting',
      async chat() {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
        return { message: { role: 'assistant', content: 'ok' } }
      },
    }
    const { runner } = makeRunner(dir, provider, { maxConcurrency: 1 })
    await runTask(runner, { mode: 'parallel', tasks: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }] }, { cwd: dir, allowBash: false, agentId: 'main', depth: 0 })
    expect(maxActive).toBe(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a child that blows its token budget is aborted and reported', async () => {
  const dir = await sandbox()
  try {
    let calls = 0
    const provider: Provider = {
      name: 'spend',
      async chat(req) {
        if (req.signal?.aborted) throw new Error('aborted by signal')
        calls++
        return {
          message: assistantTool('t' + calls, 'list_dir', { path: '.' }),
          usage: { prompt_tokens: 100, completion_tokens: 100 },
        }
      },
    }
    const { runner } = makeRunner(dir, provider, { maxTokens: 250 })
    const result = await runner.run('worker', 'spend it', 'main', 0)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('budget')
    expect(result.input + result.output).toBeGreaterThan(250)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parses agent role markdown and restricts tools', () => {
  const role = parseAgentMarkdown(
    `---\nname: researcher\nmodel: deepseek-chat\ntools: read_file, list_dir\nmaxSteps: 8\n---\nYou research things.\n`,
    'fallback',
  )
  expect(role.name).toBe('researcher')
  expect(role.model).toBe('deepseek-chat')
  expect(role.tools).toEqual(['read_file', 'list_dir'])
  expect(role.maxSteps).toBe(8)
  expect(role.systemPrompt).toBe('You research things.')
})

test('task tool exposes the orchestration modes it implements', () => {
  const dir = process.cwd()
  const { runner } = makeRunner(dir, { name: 'x', async chat() { return { message: { role: 'assistant', content: 'x' } } } })
  const tool = makeTaskTool(runner)
  const modes = (tool.parameters.properties as Record<string, { enum?: string[] }>).mode?.enum
  expect(modes).toEqual(['single', 'parallel', 'chain', 'race'])
})

test('formats an agent tree with per-agent tokens and cost', () => {
  const events: TaggedEvent[] = [
    { agentId: 'main', parentId: null, seq: 1, t: 0, event: { type: 'session.start', model: 'm', cwd: '.' } },
    { agentId: 'main', parentId: null, seq: 2, t: 0, event: { type: 'usage', input: 100, output: 50, cost: 0.001 } },
    { agentId: 'main', parentId: null, seq: 3, t: 0, event: { type: 'turn.end', stopReason: 'stop', text: 'done' } },
    { agentId: 'main/worker-1', parentId: 'main', seq: 1, t: 0, event: { type: 'usage', input: 200, output: 100, cost: 0.002 } },
    { agentId: 'main/worker-1', parentId: 'main', seq: 2, t: 0, event: { type: 'turn.end', stopReason: 'stop', text: 'child' } },
  ]
  const text = formatAgentTree(buildAgentTree(events))
  expect(text).toContain('main · done · 150tok · $0.001000')
  expect(text).toContain('worker-1 · done · 300tok · $0.002000')
  expect(text).toContain('total cost: $0.003000')
})
