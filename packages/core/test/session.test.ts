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
