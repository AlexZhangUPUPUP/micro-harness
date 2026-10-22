import { expect, test } from 'bun:test'
import { renderMarkdown, summarizeModes } from '../report.ts'
import type { AttemptResult, ContextReport, StageResult } from '../types.ts'

/** 构造已报告计量的尝试，测试用例仅覆盖需要改变的字段。 */
function attempt(patch: Partial<AttemptResult> = {}): AttemptResult {
  return {
    scenario: 'memory', title: '约束保持', seed: 'fixed', run: 1,
    backend: 'mock', mode: 'drop-middle', status: 'pass', stages: [], validityIssues: [],
    metrics: { requests: 2, usageReported: 2, inputTokens: 100, outputTokens: 20,
      cachedInputTokens: 5, summaryInputTokens: 30, summaryOutputTokens: 4,
      estimatedCost: 0.01, ms: 12 },
    ...patch,
  }
}

/** 构造带约束遗漏、纠正遗漏和恢复失败的阶段。 */
function stage(): StageResult {
  return {
    stage: 1, answer: '{"constraint":"wrong"}', inputBefore: 300, inputAfter: 100,
    retainedRatio: 1 / 3, trimStrategies: ['none', 'keep-head+tail'],
    restored: true, restoreMatches: false,
    grade: { passed: false, repeatedTools: ['read_file'], checks: [
      { field: 'constraint', expected: 'keep', actual: 'wrong', passed: false, category: 'constraint' },
      { field: 'correction', expected: 'latest', actual: null, passed: false, category: 'correction' },
    ] },
  }
}

/** 构造完整 JSON 报告，默认明确标识 mock 机制验证。 */
function report(attempts: AttemptResult[]): ContextReport {
  return {
    version: 1, assessment: 'mechanism-only', attempts,
    config: { backend: 'mock', model: 'scripted', startedAt: '2026-10-22T00:00:00Z',
      runs: 1, budget: 1000, baselineBudget: 5000, outputTokens: 200, seed: 'fixed',
      requestTimeoutMs: 1000, maxRequests: 10, maxCost: 1, pricingSource: 'test fixture' },
  }
}

// error 和 invalid 保持独立，行为遗漏及恢复结果从阶段明细计算。
test('mode summaries separate outcome statuses and count mechanism evidence', () => {
  const summary = summarizeModes([
    attempt({ stages: [stage()], status: 'fail' }), attempt(),
    attempt({ status: 'error' }), attempt({ status: 'invalid' }),
  ])[0]!
  expect(summary).toMatchObject({ attempts: 4, pass: 1, fail: 1, error: 1, invalid: 1,
    passRate: 0.5, constraintMisses: 1, correctionMisses: 1, repeatedTools: 1,
    compressions: 1, restored: 1, restoreMatches: 0, restoreMismatches: 1, restoreUnknown: 0 })
  expect(summary.metrics).toMatchObject({ requests: 8, usageReported: 8,
    inputTokens: 400, outputTokens: 80, cachedInputTokens: 20,
    summaryInputTokens: 120, summaryOutputTokens: 16, ms: 48 })
  expect(summary.metrics.estimatedCost).toBeCloseTo(0.04)
})

// 混合报告也不能把 mock 与真实模型合并成同一个模式统计。
test('summaries never merge mock and real evidence', () => {
  const summaries = summarizeModes([attempt(), attempt({ backend: 'real', status: 'fail' })])
  expect(summaries).toHaveLength(2)
  expect(summaries.find((summary) => summary.backend === 'mock')?.passRate).toBe(1)
  expect(summaries.find((summary) => summary.backend === 'real')?.passRate).toBe(0)
  const markdown = renderMarkdown(report([attempt(), attempt({ backend: 'real' })]))
  expect(markdown).toContain('混合后端')
})

// 部分 usage 缺失时，不能把剩余部分累加为完整总量或零费用。
test('unknown usage and cost remain null in JSON and unknown in Markdown', () => {
  const missing = attempt({ status: 'invalid', metrics: {
    requests: 1, usageReported: 0, inputTokens: null, outputTokens: null,
    cachedInputTokens: null, summaryInputTokens: null, summaryOutputTokens: null,
    estimatedCost: null, ms: 3,
  } })
  const summary = summarizeModes([attempt(), missing])[0]!
  expect(summary.metrics.inputTokens).toBeNull()
  expect(summary.metrics.estimatedCost).toBeNull()
  expect(JSON.parse(JSON.stringify(report([missing]))).attempts[0].metrics.estimatedCost).toBeNull()
  const markdown = renderMarkdown(report([missing]))
  expect(markdown).toContain('estimatedCost=unknown')
  expect(markdown).not.toContain('$0.000000')
  expect(summarizeModes([missing])[0]!.passRate).toBeNull()
})

// 对照失败或缺失时明确禁止改善归因，并提示小样本不能排名。
test('reports disclose failed or missing baselines and avoid ranking claims', () => {
  const markdown = renderMarkdown(report([
    attempt({ mode: 'full-history', status: 'fail' }), attempt(),
    attempt({ scenario: 'unpaired' }),
  ]))
  expect(markdown).toContain('memory/1/drop-middle: full-history 基线未通过或缺失')
  expect(markdown).toContain('unpaired/1/drop-middle: full-history 基线未通过或缺失')
  expect(markdown).toContain('不是 benchmark')
  expect(markdown).toContain('不生成策略排名')
  expect(renderMarkdown(report([attempt({ mode: 'full-history' }), attempt()]))).not.toContain('## Baseline validity')
})

// 明细保留期望值、实际值、失败原因及轨迹定位，不只给出最终成功率。
test('Markdown preserves inspectable stage details and escapes table content', () => {
  const result = stage()
  result.grade.checks[0]!.expected = 'keep|<tag>\nnext'
  result.grade.parseError = 'invalid JSON'
  result.error = 'stage timeout'
  const markdown = renderMarkdown(report([attempt({ stages: [result], status: 'invalid',
    validityIssues: ['baseline exceeded budget'], traceFile: 'trace.jsonl', error: 'attempt error' })]))
  expect(markdown).toContain('keep\\|&lt;tag&gt;')
  expect(markdown).toContain('invalid JSON')
  expect(markdown).toContain('stage timeout')
  expect(markdown).toContain('attempt error')
  expect(markdown).toContain('baseline exceeded budget')
  expect(markdown).toContain('trace.jsonl')
  expect(markdown).toContain('restoreMatches=false')
  expect(markdown).toContain('inputBefore=300; inputAfter=100')
})

// 真实调用报告与脚本机制验证使用不同且明确的证据标签。
test('real smoke and mock mechanism have distinct evidence labels', () => {
  const mocked = report([])
  expect(renderMarkdown(mocked)).toContain('mock-mechanism（mechanism-only')
  const real = { ...mocked, assessment: 'real-model-smoke' as const,
    config: { ...mocked.config, backend: 'real' as const, model: 'actual-model' } }
  expect(renderMarkdown(real)).toContain('real-smoke（real-model-smoke')
  expect(renderMarkdown(real)).not.toContain('mock-mechanism')
})
