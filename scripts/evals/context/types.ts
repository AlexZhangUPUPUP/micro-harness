import type { ChatMessage } from '@micro-harness/core'

/** 区分完整历史基线与两种上下文压缩策略。 */
export type ContextMode = 'full-history' | 'drop-middle' | 'summarize'
/** mock 仅验证机制，real 记录真实模型冒烟证据。 */
export type Backend = 'mock' | 'real'
/** 每个确定性断言对应的记忆任务类别。 */
export type FieldKind = 'constraint' | 'correction' | 'progress' | 'recovery'

/** 单阶段注入历史、任务和期望字段，可要求重启恢复。 */
export interface ScenarioStage {
  history: ChatMessage[]
  prompt: string
  expected: Record<string, string>
  fieldKinds: Record<string, FieldKind>
  restart?: boolean
}

/** 可复现的任务定义，不允许通过重复工具读取绕过记忆检查。 */
export interface ContextScenario {
  id: string
  title: string
  seed: string
  stages: ScenarioStage[]
  forbiddenTools: string[]
}

/** 保留逐字段期望值和实际值，支持人工复核评分。 */
export interface FieldCheck {
  field: string
  expected: string
  actual: string | null
  passed: boolean
  category: FieldKind
}

/** 评分同时记录字段遗漏、重复操作和输出解析失败。 */
export interface Grade {
  passed: boolean
  checks: FieldCheck[]
  repeatedTools: string[]
  parseError?: string
}

/** 每阶段保留压缩前后估算、恢复一致性和实际回答。 */
export interface StageResult {
  stage: number
  answer: string
  grade: Grade
  inputBefore: number
  inputAfter: number
  retainedRatio: number
  trimStrategies: string[]
  restored: boolean
  restoreMatches: boolean | null
  error?: string
}

/** 未知用量或费用使用 null，不将未知值伪装成零。 */
export interface UsageMetrics {
  requests: number
  usageReported: number
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  summaryInputTokens: number | null
  summaryOutputTokens: number | null
  estimatedCost: number | null
  ms: number
}

/** 一次模式运行的可复核结果及原始轨迹位置。 */
export interface AttemptResult {
  scenario: string
  title: string
  seed: string
  run: number
  mode: ContextMode
  backend: Backend
  status: 'pass' | 'fail' | 'error' | 'invalid'
  stages: StageResult[]
  metrics: UsageMetrics
  validityIssues: string[]
  traceFile?: string
  error?: string
}

/** 保存预算、调用上限和价格来源，限定结果适用边界。 */
export interface ReportConfig {
  backend: Backend
  model: string
  startedAt: string
  runs: number
  budget: number
  baselineBudget: number
  outputTokens: number
  seed: string
  requestTimeoutMs: number
  maxRequests: number
  maxCost: number
  pricingSource: string
}

/** JSON 报告直接保存运行契约，汇总由相同明细计算。 */
export interface ContextReport {
  version: 1
  assessment: 'mechanism-only' | 'real-model-smoke'
  config: ReportConfig
  attempts: AttemptResult[]
}
