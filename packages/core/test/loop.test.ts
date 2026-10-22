import { test, expect } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Harness } from '../src/harness.ts'
import { EventHub, type TaggedEvent } from '../src/events.ts'
import type { ChatResponse, Provider } from '../src/provider.ts'
import { cacheReadTokens, type ChatMessage } from '../src/model.ts'
import { COMPACT_RECAP_PREFIX } from '../src/context.ts'

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

function setup(
  responses: ChatResponse[],
  cwd: string,
  opts: {
    maxSteps?: number
    parallelTools?: boolean
    maxToolOutput?: number
    pricing?: { input: number; output: number; inputCached?: number }
    maxCost?: number
  } = {},
) {
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
    maxToolOutput: opts.maxToolOutput,
    pricing: opts.pricing,
    maxCost: opts.maxCost,
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

test('every model call records the exact request for the inspector', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-inspect-'))
  try {
    const { harness, events } = setup(
      [
        { message: assistantTool('c1', 'write_file', { path: 'a.txt', content: 'hi' }) },
        { message: { role: 'assistant', content: 'done' } },
      ],
      dir,
    )
    await harness.send('hello')

    const reqs = events.filter((e) => e.event.type === 'model.request').map((e) => e.event)
    expect(reqs.length).toBe(2) // one per model call
    const first = reqs[0]!
    expect(first.type === 'model.request' && first.model).toBe('fake-model')
    expect(first.type === 'model.request' && first.tools).toContain('write_file')
    expect(first.type === 'model.request' && first.system.length > 0).toBe(true)
    // the exact array that went out: system + the user turn
    const roles = (r: typeof first): string[] =>
      r.type === 'model.request' ? (r.messages as Array<{ role: string }>).map((m) => m.role) : []
    expect(roles(first)).toEqual(['system', 'user'])
    // the second call also carries the tool result from the first
    expect(roles(reqs[1]!)).toContain('tool')
    expect((reqs[1]!.type === 'model.request' && reqs[1]!.messages.length) as number).toBeGreaterThan(2)
    // and it is a snapshot: history growing later must not rewrite the record
    expect(roles(first)).toEqual(['system', 'user'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------ prompt caching & compaction */

test('a provider prompt-cache hit is surfaced and priced at the cached rate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-cache-'))
  try {
    const hub = new EventHub()
    const captured: TaggedEvent[] = []
    hub.on((e) => captured.push(e))
    const harness = new Harness({
      provider: scripted([
        {
          message: { role: 'assistant', content: 'hi' },
          usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 800 },
        },
      ]),
      model: 'fake-model',
      cwd: dir,
      hub,
      pricing: { input: 1, output: 2, inputCached: 0.1 }, // USD per 1M tokens
    })
    await harness.send('x')

    const usage = captured.map((e) => e.event).find((e) => e.type === 'usage')
    expect(usage && 'cacheRead' in usage ? usage.cacheRead : null).toBe(800)
    // 200 uncached @ $1/M + 800 cached @ $0.1/M + 100 output @ $2/M
    expect(usage && 'cost' in usage ? usage.cost : null).toBeCloseTo(480e-6, 9)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('no cacheRead field is emitted when the provider reports no hit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-nocache-'))
  try {
    const { harness, events } = setup(
      [{ message: { role: 'assistant', content: 'hi' }, usage: { prompt_tokens: 10, completion_tokens: 1 } }],
      dir,
    )
    await harness.send('x')
    const usage = events.map((e) => e.event).find((e) => e.type === 'usage')
    expect(usage && 'cacheRead' in usage).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('cache dialects are normalized (DeepSeek / OpenAI / Anthropic)', () => {
  expect(cacheReadTokens({ prompt_cache_hit_tokens: 5 })).toBe(5)
  expect(cacheReadTokens({ prompt_tokens_details: { cached_tokens: 7 } })).toBe(7)
  expect(cacheReadTokens({ cache_read_input_tokens: 9 })).toBe(9)
  expect(cacheReadTokens({ prompt_tokens: 10 })).toBe(0)
  expect(cacheReadTokens(undefined)).toBe(0)
})

test('an oversized tool result is capped once, when it is appended', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-cap-'))
  try {
    const big = 'x'.repeat(40_000)
    writeFileSync(path.join(dir, 'big.txt'), big)
    const { harness, events } = setup(
      [
        { message: assistantTool('c1', 'read_file', { path: 'big.txt' }) },
        { message: { role: 'assistant', content: 'done' } },
      ],
      dir,
      { maxToolOutput: 1000 },
    )
    await harness.send('read the big file')

    // `read_file` has its own ~20k-char cap; the harness cap is a second, tighter one
    // that applies to every tool (bash, MCP tools, ...), so measure against that.
    const result = events.map((e) => e.event).find((e) => e.type === 'tool.result')
    expect(result && 'elided' in result ? result.elided : 0).toBeGreaterThan(18_000)
    // the event keeps the tool's own full output for the trace/UI
    expect(String(result && 'output' in result ? result.output : '').length).toBeGreaterThan(19_000)

    // ...but the message the model sees is capped, and says so
    const toolMsg = harness.messages.find((m) => m.role === 'tool')
    const content = String(toolMsg?.content ?? '')
    expect(content.length).toBeLessThan(1200)
    expect(content).toMatch(/characters elided/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('later turns never rewrite what was already sent (a cacheable prefix)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-prefix-'))
  try {
    const { harness, events } = setup(
      [
        { message: assistantTool('c1', 'write_file', { path: 'a.txt', content: 'hi' }) },
        { message: { role: 'assistant', content: 'done' } },
      ],
      dir,
    )
    await harness.send('write it')
    const reqs = events
      .map((e) => e.event)
      .filter((e): e is Extract<TaggedEvent['event'], { type: 'model.request' }> => e.type === 'model.request')
    expect(reqs.length).toBe(2)
    const [first, second] = [reqs[0]!.messages, reqs[1]!.messages]
    expect(second.length).toBeGreaterThan(first.length)
    // request #2 is request #1 plus the new turn: byte-identical prefix, so the
    // provider's prompt cache can hit on everything that came before.
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------------------------------------------- compaction strategy & budget */

test("compact: 'summarize' folds the dropped turns into a recap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-sum-'))
  try {
    const hub = new EventHub()
    const captured: TaggedEvent[] = []
    hub.on((e) => captured.push(e))
    const harness = new Harness({
      // the summarizer runs *before* the turn's model call, so it consumes the third
      // response: #1 'one', #2 'two', #3 the recap (summarizer), #4 the answer.
      provider: scripted([
        { message: { role: 'assistant', content: 'one' } },
        { message: { role: 'assistant', content: 'two' } },
        { message: { role: 'assistant', content: 'earlier turns were about a and b' } },
        { message: { role: 'assistant', content: 'three' } },
      ]),
      model: 'fake-model',
      cwd: dir,
      hub,
      // 使用可容纳规则、工具定义和输出预留的窗口，第三轮才触发摘要。
      systemPrompt: 'sys',
      tools: [],
      maxContextTokens: 220,
      compact: 'summarize',
    })
    await harness.send('first turn ' + 'a'.repeat(220))
    await harness.send('second turn ' + 'b'.repeat(220))
    await harness.send('third turn ' + 'c'.repeat(220))

    const trims = captured.map((e) => e.event).filter((e) => e.type === 'context.trim')
    expect(trims.length).toBeGreaterThan(0)
    expect(trims.some((t) => t.type === 'context.trim' && t.strategy === 'summarize')).toBe(true)

    const requests = captured
      .map((e) => e.event)
      .filter((e): e is Extract<TaggedEvent['event'], { type: 'model.request' }> => e.type === 'model.request')
    const last = requests[requests.length - 1]!
    const contents = last.messages.map((m) => String((m as ChatMessage).content ?? ''))
    const recap = contents.find((c) => c.startsWith(COMPACT_RECAP_PREFIX))
    expect(recap).toBeDefined()
    expect(recap!).toContain('earlier turns were about a and b')
    expect(recap!.length).toBeLessThan(1300)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the cost budget stops the run instead of spending without limit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-budget-'))
  try {
    const { harness, events } = setup(
      [
        { message: { role: 'assistant', content: 'first' }, usage: { prompt_tokens: 1000, completion_tokens: 100 } },
        { message: { role: 'assistant', content: 'second' }, usage: { prompt_tokens: 1000, completion_tokens: 100 } },
      ],
      dir,
      { pricing: { input: 1, output: 1 }, maxCost: 0.0005 },
    )
    const text = await harness.send('spend money')

    expect(text).toMatch(/cost budget/)
    const types = events.map((e) => e.event.type)
    expect(types).toContain('error')
    const err = events.map((e) => e.event).find((e) => e.type === 'error')
    expect(err && 'fatal' in err ? err.fatal : false).toBe(true)
    const end = [...events].reverse().find((e) => e.event.type === 'turn.end')
    expect(end && 'stopReason' in end.event ? end.event.stopReason : '').toBe('budget')
    // it stopped after the first paid call rather than running the script dry
    expect(events.filter((e) => e.event.type === 'usage').length).toBe(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------ multimodal sends */

import type { ContentPart } from '../src/model.ts'

test('send with images produces array content with a data URL; without images stays a string', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-img-'))
  try {
    const run = async (images?: Array<{ mimeType: string; data: string }>) => {
      const hub = new EventHub()
      const captured: TaggedEvent[] = []
      hub.on((e) => captured.push(e))
      const harness = new Harness({
        provider: scripted([{ message: { role: 'assistant', content: 'ok' } }]),
        model: 'fake-model',
        cwd: dir,
        hub,
      })
      await harness.send('describe this', undefined, images)
      const req = captured.map((e) => e.event).find((e) => e.type === 'model.request')
      expect(req && req.type === 'model.request').toBe(true)
      const msgs = req && req.type === 'model.request' ? (req.messages as ChatMessage[]) : []
      return msgs[msgs.length - 1]!
    }

    const withImages = await run([{ mimeType: 'image/png', data: 'AAAA' }])
    expect(withImages.role).toBe('user')
    expect(Array.isArray(withImages.content)).toBe(true)
    const parts = withImages.content as ContentPart[]
    expect(parts[0]).toEqual({ type: 'text', text: 'describe this' })
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } })

    const textOnly = await run()
    expect(textOnly.role).toBe('user')
    expect(textOnly.content).toBe('describe this')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a run stops once the cost budget is exceeded', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-budget-'))
  try {
    const { harness, events } = setup(
      [
        {
          message: { role: 'assistant', content: 'expensive' },
          usage: { prompt_tokens: 1000, completion_tokens: 1000 },
        },
      ],
      dir,
      { pricing: { input: 1, output: 1 }, maxCost: 0 },
    )
    const text = await harness.send('go')
    expect(text).toContain('cost budget')
    const ends = events.map((e) => e.event).filter((e) => e.type === 'turn.end')
    expect(ends.at(-1)).toMatchObject({ stopReason: 'budget' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
