import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { compactMessages, estimateTokens, trimMessages, truncateToolOutput } from '../src/context.ts'
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

/* ------------------------------------------------------- compaction & caching */

test('truncateToolOutput keeps the head and the tail and says what it cut', () => {
  const short = truncateToolOutput('small', 100)
  assert.equal(short.elided, 0)
  assert.equal(short.text, 'small')

  const text = 'A'.repeat(500) + 'B'.repeat(500)
  const { text: capped, elided } = truncateToolOutput(text, 200)
  assert.equal(elided, 800)
  assert.ok(capped.startsWith('A'), 'keeps the head')
  assert.ok(capped.endsWith('B'), 'keeps the tail')
  assert.ok(capped.includes('800 of 1000 characters elided'))
  assert.ok(capped.length < text.length)
})

test('compaction drops the middle and keeps the head', () => {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: 'user', content: `user ${i} ` + 'x'.repeat(300) })
    msgs.push({ role: 'assistant', content: `answer ${i} ` + 'y'.repeat(300) })
  }
  const r = compactMessages(msgs, { maxTokens: 400 })
  assert.equal(r.strategy, 'keep-head+tail')
  assert.equal(r.messages[0]!.role, 'system')
  // the first user turn (the constraints) survives even though it is the oldest
  assert.equal(r.messages[1]!.content, msgs[1]!.content)
  assert.ok(r.dropped > 0)
  // ...and the newest turn is still there
  assert.equal(r.messages[r.messages.length - 1]!.content, msgs[msgs.length - 1]!.content)
  assert.ok(r.tokens > 0 && r.tokens <= 400 + estimateTokens([msgs[0]!, msgs[1]!, msgs[msgs.length - 2]!, msgs[msgs.length - 1]!]))
})

test('compaction never rewrites the part it keeps (a stable cache prefix)', () => {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 12; i++) {
    msgs.push({ role: 'user', content: `u${i} ` + 'x'.repeat(200) })
    msgs.push({ role: 'assistant', content: `a${i} ` + 'y'.repeat(200) })
  }
  const compacted = compactMessages(msgs, { maxTokens: 300 }).messages
  // system + first unit are byte-identical to the originals
  assert.deepEqual(compacted.slice(0, 3), msgs.slice(0, 3))
  // and the tail is a suffix of the original ordering
  const tail = compacted.slice(3)
  assert.deepEqual(tail, msgs.slice(msgs.length - tail.length))
})

test('keepHead: false falls back to a tail window', () => {
  const msgs: ChatMessage[] = [{ role: 'system', content: 's' }]
  for (let i = 0; i < 10; i++) msgs.push({ role: 'user', content: `u${i} ` + 'x'.repeat(300) })
  const r = compactMessages(msgs, { maxTokens: 200, keepHead: false })
  assert.equal(r.strategy, 'tail')
  assert.notEqual(r.messages[1]!.content, msgs[1]!.content)
})

test('a single oversized unit is kept rather than trimmed to nothing', () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'x'.repeat(9000) },
  ]
  const r = compactMessages(msgs, { maxTokens: 50 })
  assert.equal(r.messages.length, 2)
  assert.equal(r.strategy, 'tail', 'with a single unit there is no head to keep')
})
