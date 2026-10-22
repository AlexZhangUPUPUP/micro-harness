import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { readConfig } from '../config.ts'
import { requestVisibleProvider, visibleFacts } from '../mock.ts'
import { EvaluationBudget, UsageObserver } from '../provider.ts'
import { runAttempt, validityIssues } from '../runner.ts'
import { buildScenarios } from '../scenarios.ts'
import { auditSummaries } from '../audit.ts'
import type { ChatRequest, Provider } from '../../../../packages/core/src/provider.ts'
import type { StageResult } from '../types.ts'

/** 构造只有请求可见事实的任务，不提供期望对象。 */
function request(value?: string): ChatRequest {
  return { model: 'fake', tools: [], messages: [{ role: 'system', content: 'rules' },
    { role: 'user', content: `${value ? `STATE marker=${value}\n` : ''}FIELDS: ["marker"]` }] }
}

// 替换或删除可见事实必须改变结果，证明 mock 没有隐藏答案来源。
test('visible mock follows counterfactual inputs and cannot recover absent facts', async () => {
  const provider = requestVisibleProvider()
  expect((await provider.chat(request('first_nonce'))).message.content).toBe('{"marker":"first_nonce"}')
  expect((await provider.chat(request('second_nonce'))).message.content).toBe('{"marker":"second_nonce"}')
  expect((await provider.chat(request())).message.content).toBe('{"marker":"unknown"}')
  expect(visibleFacts([{ role: 'user', content: 'STATE marker=old\nSTATE marker=new' }])).toEqual({ marker: 'new' })
})

// 输入或输出计量缺失时不能把部分消耗或缺失字段伪装为零。
test('provider observations preserve unknown usage and cost', async () => {
  const observer = new UsageObserver({ input: 1, output: 1 })
  const provider: Provider = { name: 'missing', async chat() { return { message: { role: 'assistant', content: '{}' } } } }
  await observer.wrap(provider, new EvaluationBudget(2, 1), 100).chat(request())
  expect(observer.metrics(1)).toMatchObject({ requests: 1, usageReported: 0,
    inputTokens: null, outputTokens: null, estimatedCost: null, summaryInputTokens: 0 })
})

// 用量与调用限额在三种模式之间共用，不能每次尝试重置预算。
test('shared request budget and timeout bound nonresponsive providers', async () => {
  const budget = new EvaluationBudget(1, 1)
  budget.reserve(request())
  expect(() => budget.reserve(request())).toThrow('request limit')
  const hanging: Provider = { name: 'hang', chat() { return new Promise(() => {}) } }
  await expect(new UsageObserver().wrap(hanging, new EvaluationBudget(2, 1), 5).chat(request()))
    .rejects.toThrow('timed out')
})

// 参数拼错、不可比较预算及未知凭证必须在任何付费调用前失败。
test('configuration validates experimental parameters without exposing credentials', () => {
  expect(() => readConfig(['--mock', '--runs=0'], {})).toThrow()
  expect(() => readConfig(['--mock', '--budegt=100'], {})).toThrow()
  expect(() => readConfig(['--mock', '--budget=4000', '--baseline-budget=3000'], {})).toThrow()
  expect(() => readConfig([], {})).toThrow('credentials')
  const config = readConfig(['--runs=1'], { DEEPSEEK_API_KEY: 'private-test-value' })
  expect(config.apiKey).toBe('private-test-value')
  expect(JSON.stringify(config.report)).not.toContain('private-test-value')
  expect(config.report.outputTokens).toBe(256)
})

// 有效性与答题分开：摘要失败降级、压缩未触发、基线被裁剪都不能算成功。
test('validity gates reject false baseline and summary fallback', () => {
  const stage = { trimStrategies: ['keep-head+tail'], restoreMatches: null } as StageResult
  expect(validityIssues('full-history', [stage], 1)).toContain('full-history baseline was compacted')
  expect(validityIssues('summarize', [stage, stage], 2)).toContain('summary strategy fell back to dropping')
  expect(validityIssues('drop-middle', [], 3)).toContain('fewer than two effective compactions')
})

// 真正执行恢复场景三组比较，验证基线无裁剪、两次压缩和磁盘恢复。
test('runner compares paired fixtures and verifies actual checkpoint restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'context-eval-test-'))
  try {
    const config = readConfig(['--mock', `--out-dir=${dir}`], {})
    const scenario = buildScenarios('runtime-test').find((item) => item.id === 'restart')!
    const budget = new EvaluationBudget(100, 1)
    for (const mode of ['full-history', 'drop-middle', 'summarize'] as const) {
      const result = await runAttempt(config, scenario, mode, 1, requestVisibleProvider(), budget)
      expect(result.validityIssues).toEqual([])
      expect(result.stages.filter((stage) => stage.restored).map((stage) => stage.restoreMatches)).toEqual([true])
      expect(result.metrics.estimatedCost).toBeNull()
      if (mode === 'full-history') expect(result.status).toBe('pass')
      else expect(result.stages.flatMap((stage) => stage.trimStrategies).length).toBeGreaterThanOrEqual(2)
    }
  } finally {
    // 仅清理本用例创建的临时实验目录。
    rmSync(dir, { recursive: true, force: true })
  }
})

// 超时或服务不提供 usage 时，预计额度持续保留，防止无限免费重试。
test('unknown usage keeps its cost reservation and late usage eventually settles it', async () => {
  const pricing = { input: 1_000_000, output: 1_000_000 }
  const budget = new EvaluationBudget(100, 400, pricing)
  const missing: Provider = { name: 'missing', async chat() { return { message: { role: 'assistant', content: '{}' } } } }
  const wrapped = new UsageObserver(pricing).wrap(missing, budget, 100)
  await wrapped.chat(request())
  await expect(wrapped.chat(request())).rejects.toThrow('cost limit')

  // 底层忽略取消时，迟到响应仍应结算真实已知用量。
  let finish!: (value: { message: { role: 'assistant'; content: string }; usage: { prompt_tokens: number; completion_tokens: number } }) => void
  const late: Provider = { name: 'late', chat() { return new Promise((resolve) => { finish = resolve }) } }
  const lateBudget = new EvaluationBudget(100, 400, pricing)
  const observer = new UsageObserver(pricing)
  await expect(observer.wrap(late, lateBudget, 5).chat(request())).rejects.toThrow('timed out')
  finish({ message: { role: 'assistant', content: '{}' }, usage: { prompt_tokens: 10, completion_tokens: 2 } })
  await Promise.resolve()
  await Promise.resolve()
  expect(lateBudget.estimatedCost).toBe(12)
  expect(observer.metrics(5).usageReported).toBe(1)
})

// 同一阶段反复压缩不能冒充跨阶段滚动压缩。
test('validity requires compaction across distinct stages', () => {
  const stages = [{ trimStrategies: ['summarize', 'summarize'], restoreMatches: null },
    { trimStrategies: [], restoreMatches: null }] as StageResult[]
  expect(validityIssues('summarize', stages, 2)).toContain('summary adoption did not span two distinct stages')
})

// 摘要失忆必须能区分输入选择丢失与回答生成失败，诊断过程不调用网络。
test('offline audit identifies facts excluded before summary generation', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'context-audit-test-'))
  try {
    const config = readConfig(['--mock', `--out-dir=${dir}`], {})
    const scenario = buildScenarios('audit-test').find((item) => item.id === 'progress')!
    const result = await runAttempt(config, scenario, 'summarize', 1, requestVisibleProvider(), new EvaluationBudget(100, 1))
    const audit = await auditSummaries({ version: 1, assessment: 'mechanism-only', config: config.report, attempts: [result] })
    expect(audit.networkCalls).toBe(0)
    expect(audit.inputs).toHaveLength(3)
    expect(audit.misses.some((miss) => miss.sourceVisible && !miss.summaryInputVisible
      && miss.location === 'pre-summary transcript selection')).toBe(true)
  } finally {
    // 清理仅供诊断测试使用的临时日志。
    rmSync(dir, { recursive: true, force: true })
  }
})

// 未知模型的付费请求必须显式提供价格，费用上限才有可执行含义。
test('paid context eval requires known model pricing', () => {
  expect(() => readConfig([], { MICRO_MODEL: 'unknown-model', MICRO_API_KEY: 'fake' })).toThrow('Unknown pricing')
  const config = readConfig([], { MICRO_MODEL: 'unknown-model', MICRO_API_KEY: 'fake',
    MICRO_PRICE_INPUT: '1', MICRO_PRICE_OUTPUT: '2' })
  expect(config.pricing).toMatchObject({ input: 1, output: 2 })
})
