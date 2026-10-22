import path from 'node:path'
import { PRICING_SNAPSHOT, resolvePricing, type ModelPricing } from '../../../packages/core/src/pricing.ts'
import type { ReportConfig } from './types.ts'

/** 凭证仅留在进程配置，不进入报告对象。 */
export interface EvalConfig {
  report: ReportConfig
  apiKey: string
  baseUrl: string
  pricing?: ModelPricing
  outDir: string
  scenarios?: string[]
}

/** 解析明确允许的参数，拼写错误不能悄悄变成默认实验。 */
function flags(args: string[]): Map<string, string> {
  const allowed = new Set(['mock', 'runs', 'budget', 'baseline-budget', 'output-tokens', 'seed',
    'timeout', 'max-requests', 'max-cost', 'out-dir', 'scenarios'])
  const result = new Map<string, string>()
  for (const arg of args) {
    const [name, ...value] = arg.replace(/^--/, '').split('=')
    if (!arg.startsWith('--') || !allowed.has(name!)) throw new Error(`Unknown argument: ${arg}`)
    if (result.has(name!)) throw new Error(`Duplicate argument: ${name}`)
    if (name !== 'mock' && !value.join('=')) throw new Error(`--${name} requires =value`)
    if (name === 'mock' && value.length) throw new Error('--mock does not accept a value')
    result.set(name!, value.join('='))
  }
  return result
}

/** 校验数值范围，阻止无界调用或不可比较的实验。 */
function numberFlag(values: Map<string, string>, name: string, fallback: number, integer = true): number {
  const value = Number(values.get(name) ?? fallback)
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`--${name} must be a positive ${integer ? 'integer' : 'number'}`)
  }
  return value
}

/** 选择现有模型配置，并在非 mock 模式下验证凭证来源。 */
function connection(env: NodeJS.ProcessEnv, mock: boolean) {
  const model = env.MICRO_MODEL || env.OPENAI_MODEL || 'deepseek-chat'
  const baseUrl = env.MICRO_BASE_URL || env.OPENAI_BASE_URL || 'https://api.deepseek.com'
  const url = new URL(baseUrl)
  if (url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid model base URL')
  const apiKey = env.MICRO_API_KEY || env.OPENAI_API_KEY
    || (url.hostname === 'api.deepseek.com' ? env.DEEPSEEK_API_KEY : '') || ''
  if (!mock && !apiKey) throw new Error('Missing model credentials; set MICRO_API_KEY or use --mock')
  return { model, baseUrl, apiKey }
}

/** 固定三组共享参数，真实模式默认只运行一次冒烟。 */
export function readConfig(args: string[], env: NodeJS.ProcessEnv = process.env): EvalConfig {
  const values = flags(args)
  const backend = values.has('mock') ? 'mock' : 'real'
  const remote = connection(env, backend === 'mock')
  const budget = numberFlag(values, 'budget', 3200)
  const baselineBudget = numberFlag(values, 'baseline-budget', 32000)
  const outputTokens = numberFlag(values, 'output-tokens', 256)
  if (baselineBudget <= budget || budget <= outputTokens + 512) throw new Error('Budgets leave insufficient input space')
  const pricing = resolvePricing(remote.model, { input: Number(env.MICRO_PRICE_INPUT),
    output: Number(env.MICRO_PRICE_OUTPUT), inputCached: Number(env.MICRO_PRICE_INPUT_CACHED) })
  // 付费评测必须能计算保守费用额度，未知模型不能仅展示一个无效上限。
  if (backend === 'real' && !pricing) throw new Error('Unknown pricing: set MICRO_PRICE_INPUT and MICRO_PRICE_OUTPUT')
  const startedAt = new Date().toISOString()
  const report: ReportConfig = { backend, model: backend === 'mock' ? 'request-visible-mock' : remote.model,
    startedAt, runs: numberFlag(values, 'runs', 1), budget, baselineBudget, outputTokens,
    seed: values.get('seed') ?? 'context-v1', requestTimeoutMs: numberFlag(values, 'timeout', 60000),
    maxRequests: numberFlag(values, 'max-requests', 100), maxCost: numberFlag(values, 'max-cost', 0.25, false),
    pricingSource: backend === 'mock' ? 'unknown: scripted usage is not provider billing'
      : pricing ? `configured/default estimate; table snapshot ${PRICING_SNAPSHOT}` : 'unknown',
  }
  const outDir = path.resolve(values.get('out-dir') ?? `reports/context/${startedAt.replace(/[:.]/g, '-')}-${backend}`)
  return { report, apiKey: remote.apiKey, baseUrl: remote.baseUrl,
    pricing: backend === 'mock' ? undefined : pricing, outDir,
    scenarios: values.get('scenarios')?.split(',').map((value) => value.trim()).filter(Boolean) }
}
