import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  COMPACT_RECAP_PREFIX,
  compactMessages,
  compactMessagesAsync,
  estimateTokens,
  trimMessages,
  truncateToolOutput,
} from '../src/context.ts'
import { makeSummarizer } from '../src/compact.ts'
import type { ChatMessage } from '../src/model.ts'
import type { Provider } from '../src/provider.ts'

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

/* ------------------------------------------------------------- summarize seam */

test('compactMessagesAsync summarizer replaces the middle with one recap message', async () => {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: 'user', content: `user ${i} ` + 'x'.repeat(300) })
    msgs.push({ role: 'assistant', content: `answer ${i} ` + 'y'.repeat(300) })
  }
  const det = compactMessages(msgs, { maxTokens: 400 })
  const r = await compactMessagesAsync(msgs, {
    maxTokens: 400,
    summarizer: async (dropped) => `folded ${dropped.length} messages`,
  })

  assert.equal(r.strategy, 'summarize')
  assert.equal(r.summarized, det.dropped, 'every dropped message is folded into the recap')
  assert.equal(r.dropped, det.dropped - 1, 'the recap counts as one kept message')

  // system + first user unit are byte-identical to the originals
  assert.deepEqual(r.messages.slice(0, 3), msgs.slice(0, 3))

  const recap = r.messages[3]!
  assert.equal(recap.role, 'user')
  assert.ok(recap.content!.startsWith(COMPACT_RECAP_PREFIX), 'recap is prefixed')
  assert.ok(recap.content!.includes('folded'), 'recap carries the summarizer output')

  // ...and the newest kept units are still a suffix of the original ordering
  const tail = r.messages.slice(4)
  assert.deepEqual(tail, msgs.slice(msgs.length - tail.length))
})

test('compactMessagesAsync summarizer never orphans a tool result', async () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'start' },
    { role: 'assistant', content: 'ok start' },
    { role: 'user', content: 'middle ' + 'm'.repeat(400) },
    { role: 'assistant', content: 'mid-ans ' + 'm'.repeat(400) },
    { role: 'user', content: 'use a tool' },
    { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: '1', name: 'read_file', content: 'r'.repeat(400) },
  ]
  const r = await compactMessagesAsync(msgs, { maxTokens: 50, summarizer: async () => 'folded' })
  assert.equal(r.strategy, 'summarize')
  assert.ok(r.messages.some((m) => m.role === 'tool'), 'the tool result survives with its call')
  for (let i = 0; i < r.messages.length; i++) {
    if (r.messages[i]!.role === 'tool') {
      assert.equal(r.messages[i - 1]?.role, 'assistant', 'a tool message is preceded by its assistant call')
    }
  }
})

test('compactMessagesAsync falls back to drop-middle when the summarizer throws', async () => {
  const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 20; i++) {
    msgs.push({ role: 'user', content: `user ${i} ` + 'x'.repeat(300) })
    msgs.push({ role: 'assistant', content: `answer ${i} ` + 'y'.repeat(300) })
  }
  const det = compactMessages(msgs, { maxTokens: 400 })
  const r = await compactMessagesAsync(msgs, {
    maxTokens: 400,
    summarizer: async () => {
      throw new Error('boom')
    },
  })
  assert.deepEqual(r.messages, det.messages)
  assert.equal(r.strategy, 'keep-head+tail')
  assert.equal(r.dropped, det.dropped)
  assert.equal(r.summarized, undefined)
})

test('compactMessagesAsync with nothing to drop returns none and skips the summarizer', async () => {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'hi' },
  ]
  let called = false
  const r = await compactMessagesAsync(msgs, {
    maxTokens: 1000,
    summarizer: async () => {
      called = true
      return 'unused'
    },
  })
  assert.equal(r.strategy, 'none')
  assert.equal(r.dropped, 0)
  assert.equal(r.summarized, undefined)
  assert.equal(called, false)
  assert.deepEqual(r.messages, msgs)
})

/* -------------------------------------------------------- provider summarizer */

test('makeSummarizer prefixes with COMPACT_RECAP_PREFIX and honours maxChars', async () => {
  const provider: Provider = {
    name: 'fake',
    async chat() {
      return { message: { role: 'assistant', content: 'recap: ' + 'x'.repeat(5000) } }
    },
  }
  const summarize = makeSummarizer(provider, 'fake-model', { maxChars: 1200 })
  const out = await summarize([{ role: 'user', content: 'dropped' }])
  assert.ok(out.startsWith(COMPACT_RECAP_PREFIX), 'recap is prefixed')
  const summaryPart = out.slice(COMPACT_RECAP_PREFIX.length)
  assert.ok(summaryPart.trim().length <= 1200, 'summary is capped')
  assert.ok(out.length <= COMPACT_RECAP_PREFIX.length + 1 + 1200)
})

test('makeSummarizer flattens tool calls and results into the transcript', async () => {
  let transcript = ''
  const provider: Provider = {
    name: 'fake',
    async chat(req) {
      transcript = req.messages[1]?.content ?? ''
      return { message: { role: 'assistant', content: 'ok' } }
    },
  }
  const summarize = makeSummarizer(provider, 'fake-model')
  await summarize([
    { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'read_file', arguments: '{"path":"/x"}' } }] },
    { role: 'tool', tool_call_id: '1', name: 'read_file', content: 'file body' },
  ])
  assert.ok(transcript.includes('read_file'), 'includes the tool call name')
  assert.ok(transcript.includes('/x'), 'includes tool call arguments')
  assert.ok(transcript.includes('file body'), 'includes the tool result')
  assert.ok(transcript.includes('tool result'), 'labels the tool result')
})
