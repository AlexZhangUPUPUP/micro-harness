import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Harness } from '../src/harness.ts'
import { EventHub, type TaggedEvent } from '../src/events.ts'
import { SessionFile, attachSession, replay } from '../src/session.ts'
import type { ChatResponse } from '../src/provider.ts'

test('records every event to JSONL and replays them back', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-session-'))
  try {
    const hub = new EventHub()
    const session = attachSession(hub, path.join(dir, 'session.jsonl'))
    const responses: ChatResponse[] = [{ message: { role: 'assistant', content: 'hello' } }]
    let i = 0
    const harness = new Harness({
      provider: { name: 'fake', async chat() { return responses[Math.min(i++, 0)]! } },
      model: 'fake',
      cwd: dir,
      hub,
    })
    await harness.send('hi')

    const events = SessionFile.read(session.file)
    expect(events.length).toBeGreaterThan(3)
    expect(events[0]?.event.type).toBe('session.start')

    const replayed: TaggedEvent[] = []
    const n = replay(session.file, (e) => replayed.push(e))
    expect(n).toBe(events.length)
    expect(replayed.map((e) => e.event.type)).toEqual(events.map((e) => e.event.type))
    expect(replayed.every((e) => typeof e.agentId === 'string' && typeof e.seq === 'number')).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reconstructed tool calls carry type:"function" (replayed history must be valid)', async () => {
  const { reconstructMessages } = await import('../src/session.ts')
  const events = [
    { agentId: 'main', parentId: null, seq: 1, t: 1, event: { type: 'user.message', text: 'go' } },
    { agentId: 'main', parentId: null, seq: 2, t: 2, event: { type: 'tool.call', id: 'c1', name: 'write_file', args: { path: 'a.txt' } } },
    { agentId: 'main', parentId: null, seq: 3, t: 3, event: { type: 'tool.result', id: 'c1', name: 'write_file', ok: true, output: 'ok', ms: 1 } },
  ] as never[]
  const messages = reconstructMessages(events, 'sys', 'main')
  const assistant = messages.find((m) => m.role === 'assistant' && m.tool_calls?.length)
  expect(assistant?.tool_calls?.[0]?.type).toBe('function')
  expect(assistant?.tool_calls?.[0]?.id).toBe('c1')
})

test('an unanswered tool call still gets a paired tool message (interrupted run)', async () => {
  const { reconstructMessages } = await import('../src/session.ts')
  const events = [
    { agentId: 'main', parentId: null, seq: 1, t: 1, event: { type: 'user.message', text: 'go' } },
    { agentId: 'main', parentId: null, seq: 2, t: 2, event: { type: 'tool.call', id: 'c1', name: 'write_file', args: {} } },
    { agentId: 'main', parentId: null, seq: 3, t: 3, event: { type: 'tool.call', id: 'c2', name: 'bash', args: {} } },
    { agentId: 'main', parentId: null, seq: 4, t: 4, event: { type: 'tool.result', id: 'c1', name: 'write_file', ok: true, output: 'ok', ms: 1 } },
    { agentId: 'main', parentId: null, seq: 5, t: 5, event: { type: 'user.message', text: 'hello' } },
  ] as never[]
  const messages = reconstructMessages(events, 'sys', 'main')
  const at = messages.findIndex((m) => m.role === 'assistant' && m.tool_calls?.length)
  expect(messages[at].tool_calls?.map((c) => c.id)).toEqual(['c1', 'c2'])
  expect(messages.slice(at + 1, at + 3).map((m) => [m.role, m.tool_call_id])).toEqual([
    ['tool', 'c1'],
    ['tool', 'c2'],
  ])
  expect(String(messages[at + 2].content)).toContain('aborted')
  expect(messages.at(-1)).toMatchObject({ role: 'user', content: 'hello' })
})

test('parallel results arriving out of order still form one answered group', async () => {
  const { reconstructMessages } = await import('../src/session.ts')
  const events = [
    { agentId: 'main', parentId: null, seq: 1, t: 1, event: { type: 'user.message', text: 'go' } },
    { agentId: 'main', parentId: null, seq: 2, t: 2, event: { type: 'tool.call', id: 'a', name: 'read_file', args: {} } },
    { agentId: 'main', parentId: null, seq: 3, t: 3, event: { type: 'tool.call', id: 'b', name: 'list_dir', args: {} } },
    { agentId: 'main', parentId: null, seq: 4, t: 4, event: { type: 'tool.result', id: 'b', name: 'list_dir', ok: true, output: 'B', ms: 1 } },
    { agentId: 'main', parentId: null, seq: 5, t: 5, event: { type: 'tool.result', id: 'a', name: 'read_file', ok: true, output: 'A', ms: 1 } },
  ] as never[]
  const messages = reconstructMessages(events, 'sys', 'main')
  const at = messages.findIndex((m) => m.role === 'assistant' && m.tool_calls?.length)
  expect(messages[at].tool_calls?.map((c) => c.id)).toEqual(['a', 'b'])
  expect(messages.slice(at + 1).map((m) => [m.tool_call_id, m.content])).toEqual([
    ['a', 'A'],
    ['b', 'B'],
  ])
})

test('an agent log can continue a recorded sequence (resume)', async () => {
  const { AgentLog, EventHub } = await import('../src/events.ts')
  const hub = new EventHub()
  const log = new AgentLog(hub, 'main', null, 41)
  expect(log.emit({ type: 'turn.start', turn: 1 }).seq).toBe(42)
})
