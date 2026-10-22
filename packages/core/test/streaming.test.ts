import { test, expect, spyOn } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Server } from 'bun'
import { chatStream } from '../src/model.ts'
import { openaiProvider } from '../src/provider.ts'
import { Harness } from '../src/harness.ts'
import { EventHub, type TaggedEvent } from '../src/events.ts'
import type { ChatRequest, ChatResponse, Provider } from '../src/provider.ts'

/** 创建固定分片的 SSE 服务，可省略完成标记以复现断流。 */
function sseServer(chunks: string[], done = true): { server: Server<unknown>; url: string } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          // 将每个分片作为独立数据帧发送。
          for (const c of chunks) controller.enqueue(enc.encode(`data: ${c}\n\n`))
          // 兼容旧服务只发送 DONE 的完成协议。
          if (done) controller.enqueue(enc.encode('data: [DONE]\n\n'))
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

/** 使用本地服务验证失败帧，不执行任何真实模型请求。 */
async function streamScript(chunks: string[], onDelta?: () => void): Promise<unknown> {
  const { server, url } = sseServer(chunks, false)
  try {
    return await chatStream({ baseUrl: url, apiKey: 'x', model: 'fake' }, [], [], undefined, onDelta)
  } finally {
    // 无论流成功或失败都关闭测试服务。
    server.stop(true)
  }
}

test('a truncated stream rejects partial text and tool arguments', async () => {
  // 没有完成标记时，任何已累积内容都不能作为完整响应返回。
  const partial = { choices: [{ delta: { content: 'partial', tool_calls: [
    { index: 0, id: 'call_1', function: { name: 'write_file', arguments: '{"path":' } },
  ] } }] }
  await expect(streamScript([JSON.stringify(partial)])).rejects.toThrow('before completion marker')
})

test('malformed data frames fail even when followed by DONE', async () => {
  // SSE 注释允许忽略，但声明为 data 的 JSON 损坏必须报错。
  await expect(streamScript(['{"choices":', '[DONE]'])).rejects.toThrow()
  await expect(streamScript(['null', '[DONE]'])).rejects.toThrow('invalid model stream payload')
})

test('unsuccessful finish reasons reject partial results', async () => {
  // 达到输出上限或内容过滤不等于正常完成。
  for (const reason of ['length', 'content_filter']) {
    await expect(streamScript([JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })]))
      .rejects.toThrow(reason)
  }
})

test('an explicit successful finish reason completes without DONE', async () => {
  // 兼容仅以 finish_reason 结束连接的提供方。
  const result = await streamScript([JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })])
  expect((result as { message: { content: string } }).message.content).toBe('ok')
})

test('onDelta errors propagate to the caller', async () => {
  // 业务回调异常不能被解析器捕获后当成成功流忽略。
  await expect(streamScript([
    JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }), '[DONE]',
  ], () => { throw new Error('callback failed') })).rejects.toThrow('callback failed')
})


test('the harness never executes a truncated streamed tool call', async () => {
  // 使用计数工具验证执行边界，不访问文件或启动 shell。
  let executions = 0
  const { server, url } = sseServer([JSON.stringify({ choices: [{ delta: { tool_calls: [
    { index: 0, id: 'call_1', function: { name: 'count', arguments: '{}' } },
  ] } }] })], false)
  try {
    const harness = new Harness({
      provider: openaiProvider({ baseUrl: url, apiKey: 'x' }), model: 'fake', cwd: process.cwd(),
      tools: [{
        name: 'count', description: '计数测试工具', parameters: { type: 'object', properties: {} },
        // 记录实际调用次数以验证断流不会进入工具分发。
        async run() { executions++; return { output: 'counted' } },
      }],
    })
    await expect(harness.send('go')).rejects.toThrow('before completion marker')
    expect(executions).toBe(0)
  } finally {
    // 测试结束后释放本地服务。
    server.stop(true)
  }
})


/** 用内存响应验证 Reader 生命周期与网络分片，不依赖连接关闭行为。 */
async function memoryStream(parts: string[], callback?: () => void, open = false): Promise<{
  body: ReadableStream<Uint8Array>; result?: unknown; error?: unknown; cancelled: boolean
}> {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    // 按指定字节片段发送数据，覆盖跨片段与 EOF 残行。
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part))
      if (!open) controller.close()
    },
    cancel() { cancelled = true },
  })
  const mockedFetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body))
  try {
    const result = await chatStream({ baseUrl: 'http://model.invalid', apiKey: 'x', model: 'fake' }, [], [], undefined, callback)
    return { body, result, cancelled }
  } catch (error) {
    // 将错误返回给断言，同时保留资源释放后的状态。
    return { body, error, cancelled }
  } finally {
    mockedFetch.mockRestore()
  }
}

test('split frames and a final line without newline are parsed and unlocked', async () => {
  // 正常 EOF 需要处理 decoder 尾部与未换行的数据帧。
  const response = await memoryStream(['data: {"cho', 'ices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}'])
  expect(response.error).toBeUndefined()
  expect((response.result as { message: { content: string } }).message.content).toBe('ok')
  expect(response.body.locked).toBe(false)
})

test('DONE and callback failures cancel open streams and release their readers', async () => {
  // 协议完成无需等待连接关闭，回调失败也必须释放连接。
  const complete = await memoryStream(['data: [DONE]\n\n'], undefined, true)
  expect(complete.cancelled).toBe(true)
  expect(complete.body.locked).toBe(false)
  const failed = await memoryStream(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n'],
    () => { throw new Error('consumer failed') }, true)
  expect((failed.error as Error).message).toBe('consumer failed')
  expect(failed.cancelled).toBe(true)
  expect(failed.body.locked).toBe(false)
})


test('server error payloads reject instead of returning an empty answer', async () => {
  // 服务端 SSE 错误对象不具备有效响应形状。
  const response = await memoryStream(['data: {"error":{"message":"provider failed"}}\n\n'])
  expect((response.error as Error).message).toBe('invalid model stream payload')
  expect(response.body.locked).toBe(false)
})

test('reader failures and abort errors propagate and release the lock', async () => {
  // 以错误流模拟网络读取失败与请求取消，保留原始异常对象。
  for (const failure of [new Error('connection reset'), new DOMException('cancelled', 'AbortError')]) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(failure) },
    })
    const mockedFetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body))
    try {
      await expect(chatStream({ baseUrl: 'http://model.invalid', apiKey: 'x', model: 'fake' }, [], [], undefined))
        .rejects.toBe(failure)
      expect(body.locked).toBe(false)
    } finally {
      // 每轮恢复 fetch，避免影响后续测试。
      mockedFetch.mockRestore()
    }
  }
})
