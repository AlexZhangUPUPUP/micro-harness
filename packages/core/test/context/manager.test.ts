import { expect, test } from 'bun:test'
import type { ChatMessage, ToolDef } from '../../src/model.ts'
import { ContextBudgetError, ContextManager } from '../../src/context/manager.ts'
import { estimateRequestTokens } from '../../src/context/budget.ts'

// 同一个数组引用可供旧消费者持续观察，追加时不修改调用方对象。
test('manager retains its messages reference and caps only raw appended outputs', () => {
  const manager = new ContextManager({ systemPrompt: 'system', maxToolOutput: 200 })
  const reference = manager.messages
  const raw: ChatMessage = { role: 'tool', tool_call_id: 'a', content: 'x'.repeat(1000) }
  const appended = manager.append(raw)
  expect(appended.content).not.toBe(raw.content)
  expect(raw.content).toBe('x'.repeat(1000))
  manager.replace([appended])
  expect(manager.messages).toBe(reference)
  expect(manager.messages[0]).toEqual(appended)
})

// 系统指令与最新用户任务超限时应在发送请求前明确阻止。
test('prepare rejects irreducible context and includes schemas and reserved output', async () => {
  const manager = new ContextManager({ systemPrompt: 'system', maxTokens: 100 })
  manager.append({ role: 'user', content: 'x'.repeat(1000) })
  await expect(manager.prepare()).rejects.toBeInstanceOf(ContextBudgetError)
  const tools: ToolDef[] = [{ type: 'function', function: { name: 'read', description: 'x'.repeat(1000), parameters: {} } }]
  const schemaManager = new ContextManager({ systemPrompt: 's', maxTokens: 100, tools })
  await expect(schemaManager.prepare()).rejects.toBeInstanceOf(ContextBudgetError)
})

// 净消息数不减少的替换也必须根据 changed 安装到实际窗口。
test('prepare applies a single-message summary and validates final request', async () => {
  const manager = new ContextManager({ systemPrompt: 's', maxTokens: 300, compact: 'summarize',
    summarizer: async () => 'short recap' })
  manager.append({ role: 'user', content: 'first' })
  manager.append({ role: 'user', content: 'middle ' + 'x'.repeat(1500) })
  manager.append({ role: 'user', content: 'latest' })
  const prepared = await manager.prepare()
  expect(prepared.changed).toBe(true)
  expect(manager.messages.some((message) => String(message.content).includes('short recap'))).toBe(true)
  expect(prepared.inputTokens + prepared.outputReserveTokens).toBeLessThanOrEqual(300)
})

// 实际 usage 的正偏差只在原始请求前缀仍然存在时有效。
test('usage correction is preserved for append and cleared by replacement', async () => {
  const manager = new ContextManager({ systemPrompt: 's', maxTokens: 1000 })
  manager.append({ role: 'user', content: 'first' })
  const request = structuredClone(manager.messages)
  manager.observeUsage({ prompt_tokens: estimateRequestTokens(request) + 100 }, request)
  manager.append({ role: 'assistant', content: 'answer' })
  const prepared = await manager.prepare()
  expect(prepared.inputTokens).toBe(estimateRequestTokens(manager.messages) + 100)
  manager.replace(manager.messages)
  expect((await manager.prepare()).inputTokens).toBe(estimateRequestTokens(manager.messages))
})

// 显式取消必须传播，不能压缩失败后继续请求。
test('prepare propagates cancellation and exposes configured output reserve', async () => {
  const manager = new ContextManager({ systemPrompt: 's', outputReserveTokens: 32 })
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await expect(manager.prepare(controller.signal)).rejects.toThrow('cancelled')
  expect((await manager.prepare()).outputReserveTokens).toBe(32)
})

// 非有限、分数及负预算在初始化时失败，不留到外部请求阶段才暴露。
test('budget configuration rejects invalid limits and permits zero tool cap', () => {
  for (const maxTokens of [0, -1, NaN, Infinity, 1.5]) {
    expect(() => new ContextManager({ systemPrompt: 's', maxTokens })).toThrow(RangeError)
  }
  for (const outputReserveTokens of [0, -1, NaN, Infinity, 1.5]) {
    expect(() => new ContextManager({ systemPrompt: 's', outputReserveTokens })).toThrow(RangeError)
  }
  for (const safetyMarginTokens of [-1, NaN, Infinity, 1.5]) {
    expect(() => new ContextManager({ systemPrompt: 's', safetyMarginTokens })).toThrow(RangeError)
  }
  for (const maxToolOutput of [-1, NaN, Infinity, 1.5]) {
    expect(() => new ContextManager({ systemPrompt: 's', maxToolOutput })).toThrow(RangeError)
  }
  const manager = new ContextManager({ systemPrompt: 's', maxToolOutput: 0 })
  expect(manager.previewToolOutput('x'.repeat(20_000)).elided).toBe(0)
})

// 极小窗口也保留至少一个输出 token，无法容纳消息时明确失败。
test('budget reserves a positive output allowance for a one-token window', async () => {
  const manager = new ContextManager({ systemPrompt: 's', maxTokens: 1 })
  await expect(manager.prepare()).rejects.toBeInstanceOf(ContextBudgetError)
  try {
    await manager.prepare()
  } catch (error) {
    expect((error as ContextBudgetError).inputLimit).toBe(0)
  }
})

// 预览不改变模型窗口，结果与实际追加采用的截断内容一致。
test('preview reports elided metadata without mutating messages', async () => {
  const manager = new ContextManager({ systemPrompt: 's', maxToolOutput: 200 })
  const raw = 'x'.repeat(1000)
  const preview = manager.previewToolOutput(raw)
  expect(preview.elided).toBe(800)
  expect(manager.messages).toHaveLength(1)
  expect(manager.append({ role: 'tool', tool_call_id: 'a', content: raw }).content).toBe(preview.text)
  const defaultManager = new ContextManager({ systemPrompt: 's' })
  expect((await defaultManager.prepare()).outputReserveTokens).toBe(3600)
})
