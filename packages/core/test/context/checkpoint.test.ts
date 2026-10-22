import { expect, test } from 'bun:test'
import type { AgentEvent, TaggedEvent } from '../../src/events.ts'
import { capMessage, createCheckpoint, reconstructContext, validateCheckpoint } from '../../src/context/checkpoint.ts'

/** 为内存回放构造指定 Agent 的事件。 */
function tagged(event: AgentEvent, agentId = 'main'): TaggedEvent {
  return { event, agentId, parentId: null, seq: 1, t: 0 }
}

// 快照必须独立于后续窗口变更，未知版本不得被误用。
test('checkpoint clones messages and rejects unsupported or malformed data', () => {
  const messages = [{ role: 'user' as const, content: 'original' }]
  const checkpoint = createCheckpoint(messages, 200)
  messages[0]!.content = 'changed'
  expect(checkpoint.messages[0]!.content).toBe('original')
  expect(validateCheckpoint(checkpoint)).toBe(true)
  expect(validateCheckpoint({ ...checkpoint, version: 2 })).toBe(false)
  expect(validateCheckpoint({ ...checkpoint, messages: [{ role: 'invalid' }] })).toBe(false)
  expect(validateCheckpoint({ ...checkpoint, messages: [{ role: 'user', content: [null] }] })).toBe(false)
})

// 原始结果在实时追加及旧日志恢复中应用同一上限。
test('legacy replay caps raw outputs and synthesizes interrupted results', () => {
  const events = [tagged({ type: 'user.message', text: 'task' }),
    tagged({ type: 'tool.call', id: 'a', name: 'read', args: {} }),
    tagged({ type: 'tool.result', id: 'a', name: 'read', output: 'x'.repeat(1000), ok: true, ms: 1 }),
    tagged({ type: 'tool.call', id: 'b', name: 'read', args: {} })]
  const messages = reconstructContext(events, 'system', 'main', 200)
  expect(messages[3]).toEqual(capMessage({ role: 'tool', tool_call_id: 'a', name: 'read', content: 'x'.repeat(1000) }, 200))
  expect(messages.at(-1)!.content).toBe('aborted: no result recorded')
  expect(messages[2]!.tool_calls![0]!.type).toBe('function')
})

// 仅从本 Agent 最新有效快照恢复，不重复截断快照正文。
test('replay installs a checkpoint once and uses its cap only for the suffix', () => {
  const capped = capMessage({ role: 'tool', tool_call_id: 'a', name: 'read', content: 'x'.repeat(1000) }, 200)
  const checkpoint = createCheckpoint([{ role: 'system', content: 'old' },
    { role: 'user', content: 'saved' }, capped], 200)
  const events = [tagged({ type: 'user.message', text: 'obsolete' }),
    tagged({ type: 'context.checkpoint', checkpoint }),
    tagged({ type: 'context.checkpoint', checkpoint: createCheckpoint([{ role: 'user', content: 'child' }], 20) }, 'child'),
    tagged({ type: 'tool.call', id: 'b', name: 'read', args: {} }),
    tagged({ type: 'tool.result', id: 'b', name: 'read', output: 'y'.repeat(1000), ok: true, ms: 1 })]
  const restored = reconstructContext(events, 'new system', 'main', 50)
  expect(restored[0]!.content).toBe('new system')
  expect(restored[1]!.content).toBe('saved')
  expect(restored[2]).toEqual(capped)
  expect(restored.at(-1)).toEqual(capMessage({ role: 'tool', tool_call_id: 'b', name: 'read', content: 'y'.repeat(1000) }, 200))
})

// 未识别的检查点继续按原始日志恢复，图片信息不能丢失。
test('unknown checkpoint falls back to raw events and retains user images', () => {
  const checkpoint = { version: 2, messages: [], maxToolOutput: 1 }
  const events = [tagged({ type: 'user.message', text: 'look', images: [{ mimeType: 'image/png', data: 'abc' }] }),
    tagged({ type: 'context.checkpoint', checkpoint } as unknown as AgentEvent)]
  expect(reconstructContext(events, 'system')[1]!.content).toEqual([
    { type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
  ])
})

// 已开始执行工具表示混合模型输出完整，中断恢复不能丢失其文字部分。
test('mixed response text survives interruption after a real tool call', () => {
  const events = [tagged({ type: 'user.message', text: 'task' }),
    tagged({ type: 'turn.start', turn: 1 }),
    tagged({ type: 'text.delta', text: '先检查' }),
    tagged({ type: 'text.delta', text: '配置。' }),
    tagged({ type: 'tool.call', id: 'a', name: 'read', args: {} })]
  const restored = reconstructContext(events, 'system')
  expect(restored[2]!.content).toBe('先检查配置。')
  expect(restored[2]!.tool_calls![0]!.id).toBe('a')
  expect(restored[3]!.content).toBe('aborted: no result recorded')
})

// 多次模型调用分别归属各自文字，最终回答只使用完整 turn.end 文本。
test('mixed response replay separates model steps and never duplicates final text', () => {
  const events = [tagged({ type: 'user.message', text: 'task' }),
    tagged({ type: 'turn.start', turn: 1 }),
    tagged({ type: 'text.delta', text: 'first step' }),
    tagged({ type: 'tool.call', id: 'a', name: 'read', args: {} }),
    tagged({ type: 'tool.result', id: 'a', name: 'read', output: 'one', ok: true, ms: 1 }),
    tagged({ type: 'turn.start', turn: 2 }),
    tagged({ type: 'text.delta', text: 'second step' }),
    tagged({ type: 'tool.call', id: 'b', name: 'read', args: {} }),
    tagged({ type: 'tool.result', id: 'b', name: 'read', output: 'two', ok: true, ms: 1 }),
    tagged({ type: 'turn.start', turn: 3 }),
    tagged({ type: 'text.delta', text: 'final answer' }),
    tagged({ type: 'turn.end', stopReason: 'stop', text: 'final answer' })]
  const assistants = reconstructContext(events, 'system').filter((message) => message.role === 'assistant')
  expect(assistants.map((message) => message.content)).toEqual(['first step', 'second step', 'final answer'])
})

// 尚未出现工具执行或正常结束的文字不代表完整回答，边界必须清除暂存。
test('mixed response replay drops unfinished partial text at model and user boundaries', () => {
  const events = [tagged({ type: 'user.message', text: 'task' }),
    tagged({ type: 'text.delta', text: 'unfinished first' }),
    tagged({ type: 'turn.start', turn: 2 }),
    tagged({ type: 'tool.call', id: 'a', name: 'read', args: {} }),
    tagged({ type: 'tool.result', id: 'a', name: 'read', output: 'one', ok: true, ms: 1 }),
    tagged({ type: 'text.delta', text: 'unfinished second' }),
    tagged({ type: 'user.message', text: 'new task' }),
    tagged({ type: 'text.delta', text: 'unfinished last' })]
  const restored = reconstructContext(events, 'system')
  expect(restored.filter((message) => message.role === 'assistant').map((message) => message.content)).toEqual([null])
  expect(restored.at(-1)!.content).toBe('new task')
})
