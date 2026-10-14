import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Harness } from '../src/harness.ts'
import { EventHub, type TaggedEvent } from '../src/events.ts'
import type { ChatResponse, Provider } from '../src/provider.ts'
import type { ChatMessage } from '../src/model.ts'

const assistantTool = (id: string, name: string, args: unknown): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
})

/** A provider that replays a fixed script of responses. */
function scripted(responses: ChatResponse[]): Provider {
  let i = 0
  return {
    name: 'fake',
    async chat() {
      return responses[Math.min(i++, responses.length - 1)]!
    },
  }
}

function setup(responses: ChatResponse[], cwd: string, opts: { maxSteps?: number; parallelTools?: boolean } = {}) {
  const hub = new EventHub()
  const events: TaggedEvent[] = []
  hub.on((e) => events.push(e))
  const harness = new Harness({
    provider: scripted(responses),
    model: 'fake-model',
    cwd,
    hub,
    maxSteps: opts.maxSteps,
    parallelTools: opts.parallelTools,
  })
  return { harness, events, hub }
}

test('emits the turn/tool/text events and feeds tool results back', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-loop-'))
  try {
    const { harness, events } = setup(
      [
        { message: assistantTool('c1', 'write_file', { path: 'a.txt', content: 'hi' }) },
        { message: { role: 'assistant', content: 'done' } },
      ],
      dir,
    )

    const text = await harness.send('write a.txt')
    expect(text).toBe('done')

    const types = events.map((e) => e.event.type)
    expect(types[0]).toBe('session.start')
    expect(types).toContain('turn.start')
    expect(types).toContain('tool.call')
    expect(types).toContain('tool.result')
    expect(types).toContain('turn.end')
    expect(harness.messages.some((m) => m.role === 'tool')).toBe(true)

    const result = events.find((e) => e.event.type === 'tool.result')
    expect(result && 'ok' in result.event ? result.event.ok : null).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runs the tool calls of one assistant message concurrently', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-par-'))
  try {
    const two: ChatMessage = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'a', function: { name: 'write_file', arguments: JSON.stringify({ path: 'p1.txt', content: '1' }) } },
        { id: 'b', function: { name: 'write_file', arguments: JSON.stringify({ path: 'p2.txt', content: '2' }) } },
      ],
    }
    const { harness, events } = setup([{ message: two }, { message: { role: 'assistant', content: 'ok' } }], dir)
    await harness.send('write two files')

    const results = events.filter((e) => e.event.type === 'tool.result')
    expect(results.length).toBe(2)
    const toolMsgs = harness.messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.length).toBe(2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failing tool is fed back as a message instead of throwing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-err-'))
  try {
    const { harness, events } = setup(
      [
        { message: assistantTool('e1', 'read_file', { path: '../escapes-the-sandbox' }) },
        { message: { role: 'assistant', content: 'recovered' } },
      ],
      dir,
    )
    const text = await harness.send('read it')
    expect(text).toBe('recovered')

    const result = events.find((e) => e.event.type === 'tool.result')
    expect(result && 'ok' in result.event ? result.event.ok : null).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('stops at maxSteps', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-max-'))
  try {
    const endless: Provider = {
      name: 'endless',
      async chat() {
        return { message: assistantTool('x', 'list_dir', { path: '.' }) }
      },
    }
    const hub = new EventHub()
    const events: TaggedEvent[] = []
    hub.on((e) => events.push(e))
    const harness = new Harness({ provider: endless, model: 'fake', cwd: dir, hub, maxSteps: 3, parallelTools: false })

    const text = await harness.send('go')
    expect(text).toContain('step limit')
    expect(events.filter((e) => e.event.type === 'turn.start').length).toBe(3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('tags every event with the agent id and parent id', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-tag-'))
  try {
    const hub = new EventHub()
    const events: TaggedEvent[] = []
    hub.on((e) => events.push(e))
    const child = new Harness({ provider: scripted([{ message: { role: 'assistant', content: 'hi' } }]), model: 'fake', cwd: dir, hub, agentId: 'child-1', parentId: 'main' })
    await child.send('hi')
    expect(events.every((e) => e.agentId === 'child-1' && e.parentId === 'main')).toBe(true)
    expect(events.map((e) => e.seq)).toEqual([...events.map((_, i) => i + 1)])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
