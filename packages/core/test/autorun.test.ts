import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Harness } from '../src/harness.ts'
import { EventHub } from '../src/events.ts'
import { parseTaskFile, runAuto } from '../src/autorun.ts'
import type { ChatRequest, ChatResponse, Provider } from '../src/provider.ts'

const assistantTool = (id: string, name: string, args: unknown): ChatResponse => ({
  message: { role: 'assistant', content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] },
})

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mh-auto-'))
}

function makeHarness(dir: string, provider: Provider, pricing = { input: 1, output: 1 }) {
  return new Harness({ provider, model: 'fake', cwd: dir, hub: new EventHub(), pricing })
}

test('parseTaskFile ignores blanks and comments', () => {
  expect(parseTaskFile('# heading\ntask one\n\n  task two  \n# note\n')).toEqual(['task one', 'task two'])
})

test('runAuto drains the queue and reports completion', async () => {
  const dir = await sandbox()
  try {
    let calls = 0
    const provider: Provider = {
      name: 'echo',
      async chat(req: ChatRequest) {
        calls++
        const user = [...req.messages].reverse().find((m) => m.role === 'user')
        return { message: { role: 'assistant', content: `done:${String(user?.content ?? '')}` } }
      },
    }
    const harness = makeHarness(dir, provider, { input: 0, output: 0 })
    const result = await runAuto({ harness, tasks: ['a', 'b', 'c'] })
    expect(result.stopReason).toBe('completed')
    expect(result.iterations).toBe(3)
    expect(calls).toBe(3)
    expect(result.results[0]).toContain('done:a')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runAuto respects maxIterations', async () => {
  const dir = await sandbox()
  try {
    const provider: Provider = { name: 'p', async chat() { return { message: { role: 'assistant', content: 'ok' } } } }
    const harness = makeHarness(dir, provider, { input: 0, output: 0 })
    const result = await runAuto({ harness, tasks: ['a', 'b', 'c', 'd'], maxIterations: 2 })
    expect(result.stopReason).toBe('max-iterations')
    expect(result.iterations).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runAuto stops when the token budget is exceeded', async () => {
  const dir = await sandbox()
  try {
    let calls = 0
    const provider: Provider = {
      name: 'spend',
      async chat() {
        calls++
        return { message: { role: 'assistant', content: `ok${calls}` }, usage: { prompt_tokens: 100, completion_tokens: 100 } }
      },
    }
    const harness = makeHarness(dir, provider)
    const result = await runAuto({ harness, tasks: ['a', 'b', 'c'], maxTokens: 150 })
    expect(result.stopReason).toBe('token-budget')
    expect(result.tokens).toBeGreaterThan(150)
    expect(calls).toBe(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runAuto aborts an iteration that exceeds its timeout', async () => {
  const dir = await sandbox()
  try {
    const provider: Provider = {
      name: 'slow',
      async chat(req) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 500)
          req.signal?.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new Error('aborted'))
          })
        })
        return assistantTool('t', 'list_dir', { path: '.' })
      },
    }
    const harness = makeHarness(dir, provider, { input: 0, output: 0 })
    const result = await runAuto({ harness, tasks: ['a'], timeoutMs: 30 })
    expect(result.stopReason).toBe('timeout')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
