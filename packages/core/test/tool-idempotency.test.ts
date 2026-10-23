import { test, expect } from 'bun:test'
import { Harness } from '../src/harness.ts'
import { EventHub } from '../src/events.ts'
import type { ChatResponse } from '../src/provider.ts'

test('重复的工具调用 ID 只执行一次并回放确定结果', async () => {
  let executions = 0
  let response = 0
  const hub = new EventHub()
  const events = hub.collect()
  const harness = new Harness({
    provider: {
      name: 'fake',
      async chat(): Promise<ChatResponse> {
        response += 1
        if (response === 1 || response === 2) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'same-call', function: { name: 'count', arguments: '{}' } }] } }
        return { message: { role: 'assistant', content: 'done' } }
      },
    },
    model: 'fake',
    cwd: process.cwd(),
    hub,
    tools: [{ name: 'count', description: 'count', parameters: { type: 'object' }, async run() { executions += 1; return { output: 'one' } } }],
  })
  await harness.send('repeat')
  expect(executions).toBe(1)
  expect(events.filter((e) => e.event.type === 'tool.result').length).toBe(2)
  expect(events.some((e) => e.event.type === 'tool.status' && e.event.reason === 'replayed_result')).toBe(true)
})

test('恢复的 unknown 工具调用不会自动重放', async () => {
  let executions = 0
  let response = 0
  const harness = new Harness({
    provider: { name: 'fake', async chat() {
      response += 1
      return response === 1
        ? { message: { role: 'assistant', content: null, tool_calls: [{ id: 'unknown-call', function: { name: 'mutate', arguments: '{}' } }] } }
        : { message: { role: 'assistant', content: 'stopped' } }
    } },
    model: 'fake', cwd: process.cwd(), blockedToolIds: new Set(['unknown-call']),
    tools: [{ name: 'mutate', description: 'mutate', parameters: { type: 'object' }, async run() { executions += 1; return { output: 'side effect' } } }],
  })
  await harness.send('continue')
  expect(executions).toBe(0)
})
