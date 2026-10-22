import { expect, test } from 'bun:test'
import type { ChatMessage } from '../../src/model.ts'
import type { Provider, ChatRequest } from '../../src/provider.ts'
import { compactMessages, compactMessagesAsync } from '../../src/context/compact.ts'
import { estimateRequestTokens, estimateTokens } from '../../src/context/budget.ts'
import { normalizeMessages } from '../../src/context/normalize.ts'
import { makeSummarizer } from '../../src/context/summarize.ts'
import { COMPACT_RECAP_PREFIX, IMAGE_TOKENS } from '../../src/context/types.ts'

/** 构造完整工具步骤，所有测试只操作内存消息。 */
function toolStep(id: string, size = 400): ChatMessage[] {
  return [{ role: 'assistant', content: null,
    tool_calls: [{ id, function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: id, content: 'x'.repeat(size) }]
}

/** 验证调用与结果整组保留，不依赖单一工具结果紧邻助手的错误假设。 */
function expectPaired(messages: ChatMessage[]): void {
  const pending = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') for (const call of message.tool_calls ?? []) pending.add(call.id)
    if (message.role === 'tool') {
      expect(pending.has(message.tool_call_id!)).toBe(true)
      pending.delete(message.tool_call_id!)
    }
  }
  expect(pending.size).toBe(0)
}

test('UTF-8 and request schemas contribute to rough token budgets', () => {
  // 中文按 UTF-8 字节计算，图片仍使用明确的固定粗估。
  expect(estimateTokens([{ role: 'user', content: '中'.repeat(400) }])).toBe(300)
  const messages: ChatMessage[] = [{ role: 'user', content: [
    { type: 'text', text: 'abcd' }, { type: 'image_url', image_url: { url: 'data:ignored' } },
  ] }]
  expect(estimateTokens(messages)).toBe(IMAGE_TOKENS + 1)
  const base = estimateRequestTokens(messages)
  expect(base).toBeGreaterThan(estimateTokens(messages))
  expect(estimateRequestTokens(messages, [{ type: 'function', function: {
    name: 'lookup', description: 'schema', parameters: { type: 'object' },
  } }])).toBeGreaterThan(base)
})

test('oversized first-turn tool history is removable while its user constraints survive', () => {
  const first: ChatMessage = { role: 'user', content: 'keep these constraints' }
  const messages: ChatMessage[] = [{ role: 'system', content: 'system' }, first,
    ...toolStep('old', 4000), { role: 'user', content: 'next' }, ...toolStep('new', 100)]
  const result = compactMessages(messages, { maxTokens: 100 })
  expect(result.tokens).toBeLessThanOrEqual(100)
  expect(result.messages).toContain(first)
  expect(result.messages.some((message) => message.tool_call_id === 'old')).toBe(false)
  expect(result.messages.some((message) => message.tool_call_id === 'new')).toBe(true)
  expect(result.changed).toBe(true)
  expectPaired(result.messages)
})

test('newest tool group stays intact and impossible budgets report overflow', () => {
  // 最新步骤不可拆开，即使它自身已经超过允许的窗口。
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'task' },
    ...toolStep('older', 400), ...toolStep('newest', 400)]
  const result = compactMessages(messages, { maxTokens: 10 })
  expect(result.overflow).toBe(true)
  expect(result.messages.some((message) => message.tool_call_id === 'newest')).toBe(true)
  expect(result.messages.some((message) => message.tool_call_id === 'older')).toBe(false)
  expectPaired(result.messages)
})

test('unchanged input retains identity and an oversized task is explicitly marked', () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'task' }]
  const normal = compactMessages(messages, { maxTokens: 100 })
  expect(normal.changed).toBe(false)
  expect(normal.messages).toBe(messages)
  const oversized = compactMessages(messages, { maxTokens: 0 })
  expect(oversized.changed).toBe(false)
  expect(oversized.overflow).toBe(true)
})

test('summary output fits its reserved budget and preserves call groups', async () => {
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'constraints' }]
  for (let index = 0; index < 10; index++) messages.push(...toolStep(`old${index}`, 800))
  messages.push({ role: 'user', content: 'new task' }, ...toolStep('latest', 100))
  let budget = 0
  const result = await compactMessagesAsync(messages, { maxTokens: 200,
    // 模拟无视输出预算的摘要器，压缩器仍必须保证最终结果有界。
    summarizer: async (_, options) => { budget = options?.maxTokens ?? 0; return '中'.repeat(5000) },
  })
  expect(budget).toBe(30)
  expect(result.strategy).toBe('summarize')
  expect(result.tokens).toBeLessThanOrEqual(200)
  expect(String(result.messages.find((message) => String(message.content).startsWith(COMPACT_RECAP_PREFIX))?.content))
    .toStartWith(COMPACT_RECAP_PREFIX)
  expectPaired(result.messages)
})

test('replacing one message with one recap sets changed despite zero net drops', async () => {
  // 中间仅有一条大消息，摘要替代后消息数相同，但历史确实已变更。
  const messages: ChatMessage[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'rules' },
    { role: 'assistant', content: 'x'.repeat(1000) }, { role: 'user', content: 'next' }]
  const result = await compactMessagesAsync(messages, { maxTokens: 100, summarizer: async () => 'recap' })
  expect(result.strategy).toBe('summarize')
  expect(result.dropped).toBe(0)
  expect(result.changed).toBe(true)
})

test('summary failures fall back but parent cancellation propagates', async () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'rules' },
    { role: 'assistant', content: 'x'.repeat(1000) }, { role: 'user', content: 'next' }]
  const fallback = await compactMessagesAsync(messages, { maxTokens: 100,
    summarizer: async () => { throw new Error('provider failed') },
  })
  expect(fallback.messages).toEqual(compactMessages(messages, { maxTokens: 100 }).messages)
  const controller = new AbortController()
  const failure = new Error('parent cancelled')
  await expect(compactMessagesAsync(messages, { maxTokens: 100, signal: controller.signal,
    summarizer: async (_, options) => {
      expect(options?.signal).toBe(controller.signal)
      controller.abort(failure)
      throw failure
    },
  })).rejects.toBe(failure)
})

test('normalization preserves valid batches and fills only missing outputs', () => {
  const assistant: ChatMessage = { role: 'assistant', tool_calls: [
    { id: 'a', function: { name: 'first', arguments: '{}' } },
    { id: 'b', function: { name: 'second', arguments: '{}' } },
  ] }
  const resultB: ChatMessage = { role: 'tool', tool_call_id: 'b', content: 'done' }
  const input: ChatMessage[] = [assistant, resultB, { role: 'tool', tool_call_id: 'orphan', content: 'old' }]
  const normalized = normalizeMessages(input)
  expect(normalized[0]).toBe(assistant)
  expect(normalized[1]).toBe(resultB)
  expect(normalized[2]?.tool_call_id).toBe('a')
  expect(normalized[2]?.content).toContain('interrupted')
  expect(input).toHaveLength(3)
  expectPaired(normalized)
  expect(normalizeMessages(normalized)).toEqual(normalized)
})

test('normalization never attaches results across a user boundary', () => {
  const input: ChatMessage[] = [...toolStep('a').slice(0, 1), { role: 'user', content: 'new task' },
    { role: 'tool', tool_call_id: 'a', content: 'late' }]
  const normalized = normalizeMessages(input)
  expect(normalized[1]?.content).toContain('interrupted')
  expect(normalized.some((message) => message.content === 'late')).toBe(false)
  expectPaired(normalized)
})

test('provider summary bounds total input, extracts multimodal text and forwards limits', async () => {
  let request: ChatRequest | undefined
  let observed = 0
  const provider: Provider = { name: 'fake', async chat(value) {
    request = value
    return { message: { role: 'assistant', content: '中'.repeat(1000) }, usage: { prompt_tokens: 5 } }
  } }
  const summarize = makeSummarizer(provider, 'fake', { maxInputTokens: 200, onUsage: () => { observed++ } })
  const source: ChatMessage[] = [{ role: 'user', content: [
    { type: 'text', text: 'visible text' }, { type: 'image_url', image_url: { url: 'secret-base64' } },
  ] }]
  for (let index = 0; index < 100; index++) source.push({ role: 'assistant', content: 'x'.repeat(5000) })
  const summary = await summarize(source, { maxTokens: 20 })
  expect(estimateRequestTokens(request!.messages)).toBeLessThanOrEqual(200)
  expect(request?.maxTokens).toBe(20)
  expect(String(request?.messages[1]?.content)).toContain('visible text')
  expect(String(request?.messages[1]?.content)).not.toContain('secret-base64')
  expect(summary).toStartWith(COMPACT_RECAP_PREFIX)
  expect(observed).toBe(1)
})

test('summary timeout and parent cancellation stop nonresponsive providers', async () => {
  let signal: AbortSignal | undefined
  const provider: Provider = { name: 'hanging', chat(request) {
    signal = request.signal
    return new Promise(() => {})
  } }
  const summarize = makeSummarizer(provider, 'fake', { timeoutMs: 5 })
  await expect(summarize([{ role: 'user', content: 'old' }])).rejects.toThrow('timed out')
  expect(signal?.aborted).toBe(true)
  const controller = new AbortController()
  const cancelled = summarize([], { signal: controller.signal })
  controller.abort(new Error('stop summary'))
  await expect(cancelled).rejects.toThrow('stop summary')
})


test('long summary input retains the initial constraint and latest pending correction', async () => {
  let transcript = ''
  let inputTokens = 0
  const provider: Provider = { name: 'fake', async chat(request) {
    transcript = String(request.messages[1]?.content)
    inputTokens = estimateRequestTokens(request.messages)
    return { message: { role: 'assistant', content: 'handoff' } }
  } }
  const messages: ChatMessage[] = [{ role: 'user', content: 'RULE: preserve public API' }]
  // 大量旧步骤位于中间，最新纠正与待办必须进入同一次有界摘要。
  for (let index = 0; index < 100; index++) messages.push({ role: 'assistant', content: 'old step '.repeat(400) })
  messages.push({ role: 'user', content: 'LATEST CORRECTION: use port 9001; PENDING: run smoke test' })
  await makeSummarizer(provider, 'fake', { maxInputTokens: 300 })(messages)
  expect(inputTokens).toBeLessThanOrEqual(300)
  expect(transcript).toContain('RULE: preserve public API')
  expect(transcript).toContain('LATEST CORRECTION: use port 9001')
  expect(transcript).toContain('PENDING: run smoke test')
  // 选择器以结构化省略记录替代旧的全局头尾标记。
  expect(transcript).toContain('omitted_records')
})

test('late summary responses still report usage after parent cancellation', async () => {
  let finish!: (response: { message: ChatMessage; usage: { prompt_tokens: number } }) => void
  const provider: Provider = { name: 'late', chat() { return new Promise((resolve) => { finish = resolve }) } }
  const controller = new AbortController()
  let observed = 0
  const summarize = makeSummarizer(provider, 'fake', { onUsage: (usage) => { observed += usage.prompt_tokens ?? 0 } })
  const cancelled = summarize([{ role: 'user', content: 'history' }], { signal: controller.signal })
  controller.abort(new Error('cancelled parent'))
  await expect(cancelled).rejects.toThrow('cancelled parent')
  // 提供方忽略取消并迟到返回时，响应结果仍然计入真实消耗。
  finish({ message: { role: 'assistant', content: 'late handoff' }, usage: { prompt_tokens: 17 } })
  await Promise.resolve()
  expect(observed).toBe(17)
})
