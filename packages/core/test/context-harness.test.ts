import { expect, test } from 'bun:test'
import { Harness } from '../src/harness.ts'
import { EventHub, type TaggedEvent } from '../src/events.ts'
import { COMPACT_RECAP_PREFIX, ContextBudgetError } from '../src/context/index.ts'
import type { ChatMessage } from '../src/model.ts'
import type { ChatRequest, Provider } from '../src/provider.ts'

/** 用单条可压缩旧消息重建窗口，覆盖净删除数量为零的摘要场景。 */
function seed(harness: Harness): void {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'old rules' }, { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ack' }, { role: 'user', content: 'm'.repeat(1000) },
  ]
  harness.restore([{ agentId: 'main', parentId: null, seq: 1, t: 1,
    event: { type: 'context.checkpoint', checkpoint: { version: 1, messages, maxToolOutput: 12000 } } }])
}

// 不可裁的规则和任务超限时，必须在任何模型调用前失败。
test('oversized required context never reaches the provider', async () => {
  let calls = 0
  const provider: Provider = { name: 'count', async chat() {
    calls++
    return { message: { role: 'assistant', content: 'unexpected' } }
  } }
  const harness = new Harness({ provider, model: 'fake', cwd: process.cwd(), tools: [],
    systemPrompt: 's'.repeat(1000), maxContextTokens: 100 })
  await expect(harness.send('task')).rejects.toBeInstanceOf(ContextBudgetError)
  expect(calls).toBe(0)
})

// 单消息摘要虽未减少消息数，也必须进入真实请求与持久化检查点。
test('single-message summary is applied and checkpointed before the model call', async () => {
  const hub = new EventHub()
  const events = hub.collect()
  let request: ChatRequest | undefined
  const provider: Provider = { name: 'summary', async chat(input) {
    if (String(input.messages[0]?.content).startsWith('Summarize conversation')) {
      return { message: { role: 'assistant', content: 'handoff' } }
    }
    request = input
    return { message: { role: 'assistant', content: 'done' } }
  } }
  const harness = new Harness({ provider, model: 'fake', cwd: process.cwd(), tools: [], hub,
    systemPrompt: 'current rules', maxContextTokens: 150, compact: 'summarize' })
  seed(harness)
  expect(await harness.send('next')).toBe('done')
  expect(request?.messages.some((message) => String(message.content).startsWith(COMPACT_RECAP_PREFIX))).toBe(true)
  expect(request?.maxTokens).toBe(22)
  const trim = events.find((item) => item.event.type === 'context.trim')?.event
  expect(trim).toMatchObject({ type: 'context.trim', strategy: 'summarize', dropped: 0 })
  const checkpoint = events.find((item) => item.event.type === 'context.checkpoint')?.event
  expect(checkpoint?.type === 'context.checkpoint' && checkpoint.checkpoint.messages).toEqual(request!.messages)
})

// 摘要费用耗尽预算后，不允许继续启动主模型请求。
test('summary usage counts toward the run budget before the next generation', async () => {
  const hub = new EventHub()
  const events = hub.collect()
  let generations = 0
  const provider: Provider = { name: 'priced-summary', async chat(request) {
    if (String(request.messages[0]?.content).startsWith('Summarize conversation')) {
      return { message: { role: 'assistant', content: 'handoff' }, usage: { prompt_tokens: 100, completion_tokens: 10 } }
    }
    generations++
    return { message: { role: 'assistant', content: 'unexpected' } }
  } }
  const harness = new Harness({ provider, model: 'fake', cwd: process.cwd(), tools: [], hub,
    systemPrompt: 'rules', maxContextTokens: 150, compact: 'summarize', maxCost: 0.01,
    pricing: { input: 1000, output: 1000 } })
  seed(harness)
  expect(await harness.send('next')).toContain('cost budget')
  expect(generations).toBe(0)
  expect(events.find((item) => item.event.type === 'usage')?.event).toMatchObject({
    type: 'usage', purpose: 'summary', input: 100, output: 10,
  })
})

// 用真实 Harness 事件恢复图文用户输入，检查运行和续聊共享窗口格式。
test('recorded user images survive restoring a completed run', async () => {
  const hub = new EventHub()
  const events: TaggedEvent[] = hub.collect()
  const provider: Provider = { name: 'image', async chat() {
    return { message: { role: 'assistant', content: 'image received' } }
  } }
  const first = new Harness({ provider, model: 'fake', cwd: process.cwd(), tools: [], hub, systemPrompt: 'old' })
  await first.send('look', undefined, [{ mimeType: 'image/png', data: 'AAAA' }])
  const restored = new Harness({ provider, model: 'fake', cwd: process.cwd(), tools: [], systemPrompt: 'new' })
  restored.restore(events)
  expect(restored.messages[0]?.content).toBe('new')
  expect(restored.messages.slice(1)).toEqual(first.messages.slice(1))
  expect(JSON.stringify(restored.messages)).toContain('data:image/png;base64,AAAA')
})

// 提供方忽略取消并返回完整工具调用时，也不能继续执行工具。
test('cancelled requests never execute tools from a late provider response', async () => {
  const controller = new AbortController()
  let executions = 0
  const provider: Provider = { name: 'late', async chat() {
    controller.abort(new Error('user stopped'))
    return { message: { role: 'assistant', content: 'late response', tool_calls: [
      { id: 'late-call', function: { name: 'count', arguments: '{}' } },
    ] } }
  } }
  const harness = new Harness({ provider, model: 'fake', cwd: process.cwd(), systemPrompt: 'rules',
    tools: [{ name: 'count', description: '计数测试工具', parameters: { type: 'object', properties: {} },
      // 用计数替代实际文件或 shell 副作用。
      async run() { executions++; return { output: 'done' } },
    }],
  })
  await expect(harness.send('task', controller.signal)).rejects.toThrow('user stopped')
  expect(executions).toBe(0)
})
