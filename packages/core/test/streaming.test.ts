import { test, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Server } from 'bun'
import { chatStream } from '../src/model.ts'
import { openaiProvider } from '../src/provider.ts'
import { Harness } from '../src/harness.ts'
import { EventHub, type TaggedEvent } from '../src/events.ts'
import type { ChatRequest, ChatResponse, Provider } from '../src/provider.ts'

/** A tiny SSE model endpoint that plays a fixed script of deltas. */
function sseServer(chunks: string[]): { server: Server<unknown>; url: string } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          for (const c of chunks) controller.enqueue(enc.encode(`data: ${c}\n\n`))
          controller.enqueue(enc.encode('data: [DONE]\n\n'))
          controller.close()
        },
      })
      void req
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    },
  })
  return { server, url: `http://127.0.0.1:${server.port}` }
}

test('chatStream assembles text, thinking and tool calls from SSE', async () => {
  const { server, url } = sseServer([
    JSON.stringify({ choices: [{ delta: { reasoning_content: 'let me think' } }] }),
    JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
    JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"path":"a' } }] } }] }),
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.txt"}' } }] } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
  ])
  try {
    const deltas: Array<{ type: string; text: string }> = []
    const res = await chatStream(
      { baseUrl: url, apiKey: 'x', model: 'fake' },
      [{ role: 'user', content: 'hi' }],
      [],
      undefined,
      (d) => deltas.push(d),
    )
    expect(deltas.map((d) => d.type)).toEqual(['thinking', 'text', 'text'])
    expect(deltas.map((d) => d.text).join('')).toBe('let me thinkHello')
    expect(res.message.content).toBe('Hello')
    expect(res.message.tool_calls?.[0]?.id).toBe('call_1')
    // the API rejects a replayed assistant message whose tool call lacks `type`
    expect(res.message.tool_calls?.[0]?.type).toBe('function')
    expect(res.message.tool_calls?.[0]?.function.name).toBe('read_file')
    expect(res.message.tool_calls?.[0]?.function.arguments).toBe('{"path":"a.txt"}')
    expect(res.usage?.prompt_tokens).toBe(7)
  } finally {
    server.stop(true)
  }
})

test('a streamed tool call without an id still gets one', async () => {
  const { server, url } = sseServer([
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'list_dir', arguments: '{}' } }] } }] }),
    JSON.stringify({ choices: [{ delta: {} }] }),
  ])
  try {
    const res = await chatStream({ baseUrl: url, apiKey: 'x', model: 'fake' }, [{ role: 'user', content: 'hi' }], [], undefined)
    const call = res.message.tool_calls?.[0]
    expect(call?.type).toBe('function')
    expect(typeof call?.id).toBe('string')
    expect((call?.id ?? '').length).toBeGreaterThan(0)
  } finally {
    server.stop(true)
  }
})

test('openaiProvider streams when an onDelta handler is present', async () => {
  const { server, url } = sseServer([
    JSON.stringify({ choices: [{ delta: { content: 'streamed!' } }] }),
    JSON.stringify({ choices: [{ delta: {} }] }),
  ])
  try {
    const provider = openaiProvider({ baseUrl: url, apiKey: 'x' })
    const seen: string[] = []
    const res = await provider.chat({
      model: 'fake',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      onDelta: (d) => seen.push(d.text),
    })
    expect(seen).toEqual(['streamed!'])
    expect(res.message.content).toBe('streamed!')
  } finally {
    server.stop(true)
  }
})

test('the harness emits one text.delta per streamed chunk', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-stream-'))
  try {
    const hub = new EventHub()
    const events: TaggedEvent[] = []
    hub.on((e) => events.push(e))
    const provider: Provider = {
      name: 'streamer',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        req.onDelta?.({ type: 'text', text: 'a' })
        req.onDelta?.({ type: 'thinking', text: 'hmm' })
        req.onDelta?.({ type: 'text', text: 'b' })
        return { message: { role: 'assistant', content: 'ab' } }
      },
    }
    const harness = new Harness({ provider, model: 'fake', cwd: dir, hub })
    await harness.send('go')

    const textDeltas = events.filter((e) => e.event.type === 'text.delta')
    const thinking = events.filter((e) => e.event.type === 'thinking.delta')
    expect(textDeltas.map((e) => (e.event as { text: string }).text)).toEqual(['a', 'b'])
    expect(thinking.length).toBe(1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
