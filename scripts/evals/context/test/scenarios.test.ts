import { expect, test } from 'bun:test'
import { estimateTokens } from '@micro-harness/core'
import type { ChatMessage } from '@micro-harness/core'
import { buildScenarios } from '../scenarios.ts'
import { gradeAnswer } from '../grade.ts'

/** 仅为 fixture 检查展开历史，不参与模型回答构造。 */
function visibleText(history: ChatMessage[]): string {
  return history.map((message) => typeof message.content === 'string' ? message.content
    : (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')).join('\n')
}

/** 验证多工具批次具有完整的一对一结果，而不是靠孤儿工具输出施压。 */
function checkToolPairs(history: ChatMessage[]): void {
  const pending = new Set<string>()
  for (const message of history) {
    if (message.role === 'assistant') {
      expect(pending.size).toBe(0)
      for (const call of message.tool_calls ?? []) {
        expect(pending.has(call.id)).toBe(false)
        pending.add(call.id)
      }
    }
    if (message.role === 'tool') {
      expect(pending.delete(message.tool_call_id!)).toBe(true)
      expect(String(message.content).length).toBeLessThanOrEqual(1000)
    }
  }
  expect(pending.size).toBe(0)
}

test('scenario fixtures are deterministic, seed-sensitive and cover four categories', () => {
  const scenarios = buildScenarios('fixture-a')
  expect(scenarios).toEqual(buildScenarios('fixture-a'))
  expect(scenarios.map((scenario) => scenario.id)).toEqual(['constraints', 'correction', 'progress', 'restart'])
  const other = buildScenarios('fixture-b')
  // 每个场景都包含随机事实，不能靠固定字段名猜测正确答案。
  for (const [index, scenario] of scenarios.entries()) {
    expect(scenario.stages).toHaveLength(3)
    expect(scenario.stages[0]!.expected).not.toEqual(other[index]!.stages[0]!.expected)
    expect(scenario.seed).toBe('fixture-a')
  }
})

test('every stage applies bounded unavoidable pressure using complete tool batches', () => {
  // 小窗口为 2400，每个阶段自身已超过窗口，大窗口 32000 可容纳全部历史。
  for (const scenario of buildScenarios('pressure')) {
    let total = 0
    for (const stage of scenario.stages) {
      const tokens = estimateTokens(stage.history)
      expect(tokens).toBeGreaterThanOrEqual(3000)
      expect(tokens).toBeLessThanOrEqual(4000)
      total += tokens
      expect(stage.history.filter((message) => message.tool_calls?.length === 4)).toHaveLength(4)
      checkToolPairs(stage.history)
    }
    expect(total).toBeLessThan(32000)
  }
})

test('final questions expose fields only, and unchanged facts are not replanted later', () => {
  for (const scenario of buildScenarios('no-leak')) {
    let previous: Record<string, string> = {}
    let cumulative = ''
    for (const stage of scenario.stages) {
      const text = visibleText(stage.history)
      cumulative += text
      expect(Object.keys(stage.fieldKinds)).toEqual(Object.keys(stage.expected))
      expect(stage.prompt.split('FIELDS: ')[1]).toBe(JSON.stringify(Object.keys(stage.expected)))
      // 只从真正历史获得事实，最终问题不能抄写本阶段答案。
      for (const [field, expected] of Object.entries(stage.expected)) {
        expect(stage.prompt).toContain(field)
        expect(stage.prompt).not.toContain(expected)
        expect(cumulative).toContain(`STATE ${field}=${expected}`)
        if (previous[field] === expected) expect(text).not.toContain(`STATE ${field}=${expected}`)
      }
      previous = stage.expected
    }
  }
})

test('correction replaces its old value and restart has an actual restore boundary', () => {
  const scenarios = buildScenarios('boundaries')
  const correction = scenarios.find((scenario) => scenario.id === 'correction')!
  expect(correction.stages[0]!.expected.active_route).not.toBe(correction.stages[1]!.expected.active_route)
  expect(correction.stages[1]!.expected.active_route).toBe(correction.stages[2]!.expected.active_route)
  const restart = scenarios.find((scenario) => scenario.id === 'restart')!
  expect(restart.stages[1]!.restart).toBe(true)
  const content = restart.stages[0]!.history[0]!.content
  expect(Array.isArray(content) && content.some((part) => part.type === 'image_url')).toBe(true)
})

test('grading requires exact JSON field values and rejects stale or embedded answers', () => {
  const scenario = buildScenarios('grading').find((item) => item.id === 'correction')!
  const stage = scenario.stages[1]!
  expect(gradeAnswer(JSON.stringify(stage.expected), stage, [], []).passed).toBe(true)
  const stale = { ...stage.expected, active_route: scenario.stages[0]!.expected.active_route }
  expect(gradeAnswer(JSON.stringify(stale), stage, [], []).passed).toBe(false)
  expect(gradeAnswer(`quoted answer: ${JSON.stringify(stage.expected)}`, stage, [], []).parseError).toBeDefined()
  expect(gradeAnswer(JSON.stringify(Object.values(stage.expected)), stage, [], []).passed).toBe(false)
  const wrongType = { ...stage.expected, active_route: 123 }
  expect(gradeAnswer(JSON.stringify(wrongType), stage, [], []).checks[0]?.actual).toBe(null)
})

test('successful field recall cannot hide forbidden or repeated operations', () => {
  const scenario = buildScenarios('tools').find((item) => item.id === 'progress')!
  const stage = scenario.stages[0]!
  const grade = gradeAnswer(JSON.stringify(stage.expected), stage,
    ['read_file', 'run_completed_tests', 'run_completed_tests', 'publish'], scenario.forbiddenTools)
  expect(grade.checks.every((check) => check.passed)).toBe(true)
  expect(grade.passed).toBe(false)
  expect(grade.repeatedTools).toEqual(['run_completed_tests', 'publish'])
  expect(grade.checks.every((check) => check.category === 'progress')).toBe(true)
})
