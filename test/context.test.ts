import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateTokens, trimMessages } from '../src/context.ts'
import type { ChatMessage } from '../src/model.ts'

test('estimateTokens accounts for content and tool-call arguments', () => {
  const a = estimateTokens([{ role: 'user', content: 'x'.repeat(400) }])
  const b = estimateTokens([
    { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'read_file', arguments: 'y'.repeat(400) } }] },
  ])
  assert.ok(a >= 100 && b >= 100)
})

test('trim keeps the system prompt and the newest units', () => {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: 'user', content: `user ${i} ` + 'x'.repeat(200) })
    msgs.push({ role: 'assistant', content: `answer ${i} ` + 'y'.repeat(200) })
  }
  const { messages, dropped } = trimMessages(msgs, 200)
  assert.equal(messages[0]!.role, 'system')
  assert.ok(dropped > 0, 'some messages were dropped')
  assert.equal(messages[messages.length - 1]!.role, 'assistant')
  assert.equal(messages[1]!.role, 'user', 'the oldest surviving message is a user turn')
})

test('trim never orphans a tool result from its tool call', () => {
  const big = 'z'.repeat(400)
  const msgs: ChatMessage[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', name: 'read_file', content: big },
    { role: 'user', content: 'again ' + big },
    { role: 'assistant', content: 'ok ' + big },
  ]
  const { messages } = trimMessages(msgs, 50)
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'tool') {
      assert.equal(messages[i - 1]?.role, 'assistant', 'a tool message is preceded by its assistant call')
    }
  }
})
