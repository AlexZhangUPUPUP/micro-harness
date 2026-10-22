import { expect, test } from 'bun:test'
import type { ChatMessage } from '../../src/model.ts'
import { estimateRequestTokens } from '../../src/context/budget.ts'
import { selectSummaryTranscript } from '../../src/context/selection.ts'

/** 解析独立 JSON 行，保证省略不会损坏记录边界。 */
function records(text: string): Array<Record<string, unknown>> {
  return text ? text.split('\n').map((line) => JSON.parse(line)) : []
}

/** 完整请求预算同时覆盖中文和记录封装。 */
function select(messages: ChatMessage[], tokens = 900): string {
  return selectSummaryTranscript(messages, (text) => estimateRequestTokens([{ role: 'user', content: text }]) <= tokens)
}

test('retains middle corrections and distinct short observations instead of repeated logs', () => {
  // 用户纠正和短观察夹在长日志中，不能被整体头尾裁剪丢弃。
  const messages: ChatMessage[] = [{ role: 'user', content: 'Do not publish; work on branch feature-a.' }]
  for (let index = 0; index < 8; index++) messages.push({ role: 'tool', tool_call_id: `log-${index}`, content: 'noise '.repeat(3000) })
  messages.splice(4, 0, { role: 'user', content: 'Correction: use route /new-route.' },
    { role: 'tool', tool_call_id: 'result', content: 'Unit tests passed; next check the migration.' })
  const text = select(messages)
  expect(text).toContain('/new-route')
  expect(text).toContain('Do not publish')
  expect(text).toContain('Unit tests passed')
  expect(records(text).filter((record) => record.tool_call_id === 'result')).toHaveLength(1)
})

test('retains complete short messages beyond the previous per-message prefix limit', () => {
  // 短而可容纳的消息超过旧 2000 字符上限时，也必须保留末尾事实。
  const text = select([{ role: 'tool', tool_call_id: 'a', content: 'x'.repeat(2200) + ' important-tail' }], 1000)
  expect(records(text)[0]?.text).toBe('x'.repeat(2200) + ' important-tail')
})

test('keeps chronology and valid structure when a large record must be shortened', () => {
  // 大消息保留明确省略标记，调用参数仍处于完整 JSON 结构内。
  const messages: ChatMessage[] = [{ role: 'user', content: '目标'.repeat(4000) + '末尾约束' },
    { role: 'user', content: '最新纠正' }]
  const text = select(messages, 300)
  expect(estimateRequestTokens([{ role: 'user', content: text }])).toBeLessThanOrEqual(300)
  const output = records(text).filter((record) => record.role)
  expect(output[0]?.text).toContain('[... content omitted ...]')
  expect(output[0]?.text).toContain('末尾约束')
  expect(output[1]?.text).toBe('最新纠正')
})

test('deduplicates observations without merging distinct tool facts', () => {
  // 重复日志使用不同调用 ID，选择仍按内容去重且不吞掉不同结果。
  const messages: ChatMessage[] = Array.from({ length: 20 }, (_, index) => ({ role: 'tool', tool_call_id: `${index}`, content: 'same log' }))
  messages.push({ role: 'tool', tool_call_id: 'unique', content: 'artifact: result.txt' })
  const output = records(select(messages, 150)).filter((record) => record.role)
  expect(output.filter((record) => record.text === 'same log')).toHaveLength(1)
  expect(output.some((record) => record.text === 'artifact: result.txt')).toBe(true)
})

test('never exposes image bytes or breaks tiny input limits', () => {
  // 图片只留下占位；极小预算允许空正文，不能超额发送省略标记。
  const message: ChatMessage = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:secret-base64' } }] }
  expect(select([message])).toContain('[image omitted]')
  expect(select([message])).not.toContain('secret-base64')
  expect(select([message], 11)).toBe('')
})
