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
