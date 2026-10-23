import { expect, test } from 'bun:test'
import { RunBudget } from '../../src/runtime/budget.ts'

// 主 Agent 和子 Agent 使用同一实例时，预算必须按总量而不是按调用方分别计算。
test('run budget is shared and reports the first exceeded boundary', () => {
  const budget = new RunBudget({ maxTokens: 10, maxCost: 1 })
  budget.consume(4, 2, 0.2)
  expect(budget.exceeded()).toBe(false)
  const snapshot = budget.consume(3, 2, 0.3)
  expect(snapshot.input + snapshot.output).toBe(11)
  expect(snapshot.exceeded).toBe(true)
  expect(snapshot.reason).toBe('tokens')
})
