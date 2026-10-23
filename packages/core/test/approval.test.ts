import { test, expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Harness, type ApprovalMode } from '../src/harness.ts'
import { EventHub } from '../src/events.ts'
import type { ChatResponse } from '../src/provider.ts'
import type { ChatMessage } from '../src/model.ts'

const assistantTool = (id: string, name: string, args: unknown): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
})

function run(dir: string, approval: ApprovalMode, confirm?: (r: { tool: string }) => boolean) {
  const responses: ChatResponse[] = [
    { message: assistantTool('w1', 'write_file', { path: 'x.txt', content: 'x' }) },
    { message: { role: 'assistant', content: 'done' } },
  ]
  let i = 0
  const hub = new EventHub()
  const events: { type: string; decision?: string; ok?: boolean }[] = []
  hub.on((e) => events.push({ type: e.event.type, ...(('decision' in e.event ? { decision: e.event.decision } : {}) as object), ...(('ok' in e.event ? { ok: e.event.ok } : {}) as object) }))
  const harness = new Harness({
    provider: { name: 'fake', async chat() { return responses[Math.min(i++, 1)]! } },
    model: 'fake',
    cwd: dir,
    hub,
    approval,
    confirm: confirm as never,
  })
  return { harness, events }
}

test('suggest mode denies an unconfirmed mutating tool (file is not written)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-approve-'))
  try {
    const { harness, events } = run(dir, 'suggest', () => false)
    await harness.send('write it')

    const permission = events.find((e) => e.type === 'permission.result')
    expect(permission?.decision).toBe('deny')
    const result = events.find((e) => e.type === 'tool.result')
    expect(result?.ok).toBe(false)
    expect(events.some((e) => e.type === 'tool.status')).toBe(true)
    await expect(readFile(path.join(dir, 'x.txt'), 'utf8')).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('suggest mode writes the file when approved', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-approve2-'))
  try {
    const { harness, events } = run(dir, 'suggest', () => true)
    await harness.send('write it')
    expect(events.find((e) => e.type === 'permission.result')?.decision).toBe('allow')
    expect(events.filter((e) => e.type === 'tool.status').length).toBe(4)
    expect(await readFile(path.join(dir, 'x.txt'), 'utf8')).toBe('x')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('full-auto never asks', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-approve3-'))
  try {
    const { harness, events } = run(dir, 'full-auto')
    await harness.send('write it')
    expect(events.some((e) => e.type === 'permission.request')).toBe(false)
    expect(await readFile(path.join(dir, 'x.txt'), 'utf8')).toBe('x')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('auto-edit asks before a network tool', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-approve-net-'))
  try {
    const events: { type: string; tool?: string; decision?: string }[] = []
    const hub = new EventHub()
    hub.on((e) =>
      events.push({
        type: e.event.type,
        ...(('tool' in e.event ? { tool: e.event.tool } : {}) as object),
        ...(('decision' in e.event ? { decision: e.event.decision } : {}) as object),
      }),
    )
    let i = 0
    const responses: ChatResponse[] = [
      { message: assistantTool('n1', 'web_demo', {}) },
      { message: { role: 'assistant', content: 'done' } },
    ]
    const harness = new Harness({
      provider: {
        name: 'fake',
        async chat() {
          return responses[Math.min(i++, 1)]!
        },
      },
      model: 'fake',
      cwd: dir,
      hub,
      approval: 'auto-edit',
      confirm: (async () => true) as never,
      tools: [
        {
          name: 'web_demo',
          description: 'a network tool',
          parameters: { type: 'object', properties: {} },
          network: true,
          run: async () => ({ output: 'ok' }),
        },
      ],
    })
    await harness.send('search')
    expect(events.some((e) => e.type === 'permission.request' && e.tool === 'web_demo')).toBe(true)
    expect(events.find((e) => e.type === 'permission.result')?.decision).toBe('allow')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
