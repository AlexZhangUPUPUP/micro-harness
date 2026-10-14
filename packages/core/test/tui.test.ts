import { test, expect } from 'bun:test'
import { Renderer } from '../src/tui.ts'
import type { AgentEvent, TaggedEvent } from '../src/events.ts'

function tag(event: AgentEvent): TaggedEvent {
  return { agentId: 'main', parentId: null, seq: 1, t: 0, event }
}

test('renders streamed text, tool cards, usage and errors', () => {
  const chunks: string[] = []
  const renderer = new Renderer({ write: (c) => chunks.push(c), color: false, showUsage: true })
  renderer.onEvent(tag({ type: 'text.delta', text: 'Hel' }))
  renderer.onEvent(tag({ type: 'text.delta', text: 'lo' }))
  renderer.onEvent(tag({ type: 'tool.call', id: '1', name: 'read_file', args: { path: 'a.ts' } }))
  renderer.onEvent(tag({ type: 'tool.result', id: '1', name: 'read_file', ok: true, output: 'contents', ms: 4 }))
  renderer.onEvent(tag({ type: 'usage', input: 10, output: 2, cost: 0.001 }))
  renderer.onEvent(tag({ type: 'error', message: 'boom' }))
  renderer.endStream()

  const out = chunks.join('')
  expect(out).toContain('Hello')
  expect(out).toContain('read_file')
  expect(out).toContain('✓')
  expect(out).toContain('contents')
  expect(out).toContain('usage')
  expect(out).toContain('boom')
})

test('hides thinking unless enabled', () => {
  const silent: string[] = []
  const a = new Renderer({ write: (c) => silent.push(c), color: false })
  a.onEvent(tag({ type: 'thinking.delta', text: 'secret reasoning' }))
  expect(silent.join('')).not.toContain('secret reasoning')

  const loud: string[] = []
  const b = new Renderer({ write: (c) => loud.push(c), color: false, showThinking: true })
  b.onEvent(tag({ type: 'thinking.delta', text: 'visible reasoning' }))
  expect(loud.join('')).toContain('visible reasoning')
})
