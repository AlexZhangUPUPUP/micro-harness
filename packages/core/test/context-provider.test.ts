import { expect, test } from 'bun:test'
import { openaiProvider, providerCapabilityError, type ChatRequest, type Provider } from '../src/provider.ts'

// 请求级输出预算必须落实到 HTTP，且不能放宽提供方已有的更小上限。
test('provider sends the tighter output budget for streamed and ordinary requests', async () => {
  const bodies: Array<{ max_tokens?: number; stream?: boolean }> = []
  // 使用本地兼容服务捕获真实请求，避免仅断言内部配置对象。
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json() as { max_tokens?: number; stream?: boolean }
    bodies.push(body)
    if (body.stream) return new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }] })
  } })
  try {
    // 两条模型调用路径必须使用完全一致的预算优先级。
    for (const streaming of [false, true]) {
      for (const [configured, requested, expected] of [
        [undefined, 32, 32], [16, 32, 16], [64, 32, 32], [64, undefined, 64],
      ] as const) {
        const provider = openaiProvider({ baseUrl: `http://127.0.0.1:${server.port}`, apiKey: 'fake', maxTokens: configured })
        await provider.chat({ model: 'fake', messages: [{ role: 'user', content: 'task' }], tools: [],
          maxTokens: requested, ...(streaming ? { onDelta: () => {} } : {}),
        })
        expect(bodies.at(-1)?.max_tokens).toBe(expected)
      }
    }
  } finally {
    // 所有断言结束或失败后均关闭本地服务。
    server.stop(true)
  }
})

test('provider capability declarations reject unsupported request features before transport', () => {
  const request: ChatRequest = {
    model: 'fake', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] }],
    tools: [{ type: 'function', function: { name: 'tool', description: 'test', parameters: {} } }],
    signal: new AbortController().signal, onDelta: () => undefined,
  }
  const provider: Provider = { name: 'limited', capabilities: { streaming: false, tools: false, images: false, cancellation: false }, async chat() { return { message: { role: 'assistant', content: 'never' } } } }
  expect(providerCapabilityError(provider, request)).toBe('provider does not support streaming')
  expect(providerCapabilityError({ ...provider, capabilities: { tools: false } }, { ...request, onDelta: undefined, signal: undefined })).toBe('provider does not support tools')
})
