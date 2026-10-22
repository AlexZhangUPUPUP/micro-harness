import type { AttemptResult, Backend, ContextMode, ContextReport, UsageMetrics } from './types.ts'

/** 按后端与模式分别汇总，避免机制结果混入真实模型证据。 */
export interface ModeSummary {
  backend: Backend
  mode: ContextMode
  attempts: number
  pass: number
  fail: number
  error: number
  invalid: number
  passRate: number | null
  constraintMisses: number
  correctionMisses: number
  repeatedTools: number
  compressions: number
  restored: number
  restoreMatches: number
  restoreMismatches: number
  restoreUnknown: number
  metrics: UsageMetrics
}

/** 任一尝试缺少计量时，合计仍保持未知，不能把部分用量当作总量。 */
function totalMetric(attempts: AttemptResult[], key: keyof UsageMetrics): number | null {
  const values = attempts.map((attempt) => attempt.metrics[key])
  return values.some((value) => value === null) ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

/** 保留请求数及已上报 usage 数，便于识别计量覆盖不足。 */
function sumUsage(attempts: AttemptResult[]): UsageMetrics {
  return {
    requests: totalMetric(attempts, 'requests')!,
    usageReported: totalMetric(attempts, 'usageReported')!,
    inputTokens: totalMetric(attempts, 'inputTokens'),
    outputTokens: totalMetric(attempts, 'outputTokens'),
    cachedInputTokens: totalMetric(attempts, 'cachedInputTokens'),
    summaryInputTokens: totalMetric(attempts, 'summaryInputTokens'),
    summaryOutputTokens: totalMetric(attempts, 'summaryOutputTokens'),
    estimatedCost: totalMetric(attempts, 'estimatedCost'),
    ms: totalMetric(attempts, 'ms')!,
  }
}

/** 状态分开计数，成功率仅针对有明确通过或失败结论的尝试。 */
function summarizeGroup(attempts: AttemptResult[]): ModeSummary {
  const first = attempts[0]!
  const stages = attempts.flatMap((attempt) => attempt.stages)
  const checks = stages.flatMap((stage) => stage.grade.checks)
  const passed = attempts.filter((attempt) => attempt.status === 'pass').length
  const failed = attempts.filter((attempt) => attempt.status === 'fail').length
  const restored = stages.filter((stage) => stage.restored)
  return {
    backend: first.backend, mode: first.mode, attempts: attempts.length,
    pass: passed, fail: failed,
    error: attempts.filter((attempt) => attempt.status === 'error').length,
    invalid: attempts.filter((attempt) => attempt.status === 'invalid').length,
    passRate: passed + failed ? passed / (passed + failed) : null,
    constraintMisses: checks.filter((check) => check.category === 'constraint' && !check.passed).length,
    correctionMisses: checks.filter((check) => check.category === 'correction' && !check.passed).length,
    repeatedTools: stages.reduce((sum, stage) => sum + stage.grade.repeatedTools.length, 0),
    compressions: stages.reduce((sum, stage) => sum + stage.trimStrategies.filter((strategy) => strategy !== 'none').length, 0),
    restored: restored.length,
    restoreMatches: restored.filter((stage) => stage.restoreMatches === true).length,
    restoreMismatches: restored.filter((stage) => stage.restoreMatches === false).length,
    restoreUnknown: restored.filter((stage) => stage.restoreMatches === null).length,
    metrics: sumUsage(attempts),
  }
}

/** 输出稳定顺序，mock 与 real 即使误放同一报告也不会合并。 */
export function summarizeModes(attempts: AttemptResult[]): ModeSummary[] {
  const groups = new Map<string, AttemptResult[]>()
  for (const attempt of attempts) {
    const key = `${attempt.backend}/${attempt.mode}`
    const group = groups.get(key) ?? []
    group.push(attempt)
    groups.set(key, group)
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([, group]) => summarizeGroup(group))
}

/** 转义表格分隔和 HTML，保留模型输出而不改变报告结构。 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return 'unknown'
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|').replace(/\r?\n/g, ' ⏎ ')
}

/** 费用未知与真实零费用必须在 Markdown 中明确区分。 */
function cost(value: number | null): string {
  return value === null ? 'unknown' : `$${value.toFixed(6)}`
}

/** 表格与逐项详情都使用相同转义，避免原始模型内容破坏布局。 */
function row(values: unknown[]): string {
  return `| ${values.map(cell).join(' | ')} |`
}

/** 基线只有在相同后端、场景、种子和轮次通过时才构成有效对照。 */
function baselineIssues(report: ContextReport): string[] {
  const issues: string[] = []
  for (const attempt of report.attempts.filter((item) => item.mode !== 'full-history')) {
    const baseline = report.attempts.find((item) => item.mode === 'full-history'
      && item.backend === attempt.backend && item.scenario === attempt.scenario
      && item.seed === attempt.seed && item.run === attempt.run)
    if (!baseline || baseline.status !== 'pass') {
      issues.push(`${attempt.backend}/${attempt.scenario}/${attempt.run}/${attempt.mode}: full-history 基线未通过或缺失，禁止改善归因。`)
    }
  }
  return issues
}

/** 在结果表之前明确证据等级、预算与归因限制。 */
function reportHeader(report: ContextReport): string[] {
  const config = report.config
  const mock = config.backend === 'mock'
  const lines = [
    '# Context eval report', '',
    `- evidence: ${mock ? 'mock-mechanism（mechanism-only，仅机制验证）' : 'real-smoke（real-model-smoke，真实模型冒烟）'}`,
    `- assessment: ${cell(report.assessment)}; backend: ${config.backend}; model: ${cell(config.model)}`,
    `- startedAt: ${cell(config.startedAt)}; seed: ${cell(config.seed)}; runs: ${config.runs}`,
    `- budget: ${config.budget}; baselineBudget: ${config.baselineBudget}; outputTokens: ${config.outputTokens}`,
    `- limits: requestTimeoutMs=${config.requestTimeoutMs}; maxRequests=${config.maxRequests}; maxCost=${cost(config.maxCost)}`,
    `- pricingSource: ${cell(config.pricingSource)}`,
    '- 本报告为机制检查或有限真实模型冒烟，不是 benchmark；不生成策略排名或泛化改善结论。',
    '- pass rate 分母为 pass + fail；error 和 invalid 单独报告，不计作成功。',
    '- tokens 为已上报 usage；summary tokens 是其中的子集，不应再次相加；任一组成未知则合计 unknown。',
    '- ms 为尝试耗时之和；inputBefore/inputAfter 是窗口估算，不等同提供方计费 tokens。', '',
    '- mock usage 是替身的本地估算；真实模式仅测文本，图片只参与离线序列化恢复。',
    '- restart 为同进程从磁盘创建新 Harness，不是操作系统进程重启验证。',
    '- 请求上限统计 Provider 调用；底层重试未单独计数。未知用量继续占用预计费用额度。',
    '- 缓存命中与固定执行顺序会影响本轮费用，不据此得出稳健成本排名。', '',
  ]
  // 标签矛盾或混合后端时，保留证据但明确标记报告不可直接比较。
  if (report.assessment !== (mock ? 'mechanism-only' : 'real-model-smoke')
    || report.attempts.some((attempt) => attempt.backend !== config.backend)) {
    lines.push('警告：assessment/backend 不一致或含混合后端；不得合并解读。', '')
  }
  const issues = baselineIssues(report)
  if (issues.length) lines.push('## Baseline validity', '', ...issues.map((issue) => `- ${cell(issue)}`), '')
  return lines
}

/** 按模式分别显示任务结果、行为遗漏及恢复一致性。 */
function outcomeTable(summaries: ModeSummary[]): string[] {
  const lines = ['## Mode outcomes', '',
    row(['backend', 'mode', 'attempts', 'pass', 'fail', 'error', 'invalid', 'pass rate', 'constraint misses', 'correction misses', 'repeated tools', 'compressions', 'restore match/mismatch/unknown']),
    row(Array(13).fill('---'))]
  for (const summary of summaries) {
    lines.push(row([summary.backend, summary.mode, summary.attempts, summary.pass, summary.fail,
      summary.error, summary.invalid, summary.passRate === null ? null : `${(summary.passRate * 100).toFixed(1)}%`,
      summary.constraintMisses, summary.correctionMisses, summary.repeatedTools, summary.compressions,
      `${summary.restoreMatches}/${summary.restoreMismatches}/${summary.restoreUnknown} (${summary.restored} restored)`]))
  }
  return [...lines, '']
}

/** 用量表保留 unknown，避免使用不完整费用推导节省。 */
function usageTable(summaries: ModeSummary[]): string[] {
  const lines = ['## Usage by mode', '',
    row(['backend', 'mode', 'requests', 'usage reported', 'input', 'output', 'cache', 'summary input', 'summary output', 'estimated cost', 'ms']),
    row(Array(11).fill('---'))]
  for (const summary of summaries) {
    const metrics = summary.metrics
    lines.push(row([summary.backend, summary.mode, metrics.requests, metrics.usageReported,
      metrics.inputTokens, metrics.outputTokens, metrics.cachedInputTokens, metrics.summaryInputTokens,
      metrics.summaryOutputTokens, cost(metrics.estimatedCost), metrics.ms]))
  }
  return [...lines, '']
}

/** 逐阶段展示估算、原始回答和字段评分，支持从 JSON 交叉核对。 */
function stageDetails(attempt: AttemptResult): string[] {
  const lines: string[] = []
  for (const stage of attempt.stages) {
    lines.push(`### Stage ${stage.stage}`, '',
      `- inputBefore=${stage.inputBefore}; inputAfter=${stage.inputAfter}; retainedRatio=${stage.retainedRatio}`,
      `- trimStrategies=${cell(stage.trimStrategies.join(', '))}; restored=${stage.restored}; restoreMatches=${cell(stage.restoreMatches)}`,
      `- answer: ${cell(JSON.stringify(stage.answer))}`,
      `- repeatedTools: ${cell(JSON.stringify(stage.grade.repeatedTools))}`,
      `- gradePassed: ${stage.grade.passed}; parseError: ${cell(stage.grade.parseError)}`, '')
    if (stage.error) lines.push(`- error: ${cell(stage.error)}`, '')
    lines.push(row(['field', 'category', 'expected', 'actual', 'passed']), row(Array(5).fill('---')))
    for (const check of stage.grade.checks) {
      lines.push(row([check.field, check.category, JSON.stringify(check.expected),
        check.actual === null ? null : JSON.stringify(check.actual), check.passed]))
    }
    lines.push('')
  }
  return lines
}

/** 尝试明细完整保留错误、有效性说明、计量和原始轨迹定位。 */
function attemptDetails(attempt: AttemptResult): string[] {
  const metrics = attempt.metrics
  const lines = [
    `## ${cell(attempt.scenario)} / ${attempt.mode} / run ${attempt.run}`, '',
    `- title: ${cell(attempt.title)}; backend: ${attempt.backend}; seed: ${cell(attempt.seed)}; status: ${attempt.status}`,
    `- requests=${metrics.requests}; usageReported=${metrics.usageReported}; input=${cell(metrics.inputTokens)}; output=${cell(metrics.outputTokens)}; cache=${cell(metrics.cachedInputTokens)}`,
    `- summaryInput=${cell(metrics.summaryInputTokens)}; summaryOutput=${cell(metrics.summaryOutputTokens)}; estimatedCost=${cost(metrics.estimatedCost)}; ms=${metrics.ms}`,
    `- traceFile: ${cell(attempt.traceFile)}`, '',
  ]
  if (attempt.error) lines.push(`- error: ${cell(attempt.error)}`, '')
  // 无效运行的问题单列，不允许被汇总成功率掩盖。
  for (const issue of attempt.validityIssues) lines.push(`- validity issue: ${cell(issue)}`)
  return [...lines, '', ...stageDetails(attempt)]
}

/** Markdown 只从 JSON 报告明细派生，不计算未被数据支持的优越性。 */
export function renderMarkdown(report: ContextReport): string {
  const summaries = summarizeModes(report.attempts)
  return [...reportHeader(report), ...outcomeTable(summaries), ...usageTable(summaries),
    ...report.attempts.flatMap(attemptDetails)].join('\n') + '\n'
}
