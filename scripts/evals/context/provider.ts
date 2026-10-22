import { cacheReadTokens, type Usage } from '../../../packages/core/src/model.ts'
import { estimateRequestTokens } from '../../../packages/core/src/context/index.ts'
import type { ModelPricing } from '../../../packages/core/src/pricing.ts'
import type { ChatRequest, ChatResponse, Provider } from '../../../packages/core/src/provider.ts'
import type { UsageMetrics } from './types.ts'
import { isSummaryRequest } from './mock.ts'

/** 单次真实调用保留原始 usage，不能从补零后的 Harness 事件推算缺失字段。 */
interface Observation { summary: boolean; usage?: Usage; ms: number }
/** 未知用量继续占用本次预计额度，不视为免费请求。 */
interface Reservation { estimate: number; settled: boolean }

/** 有完整输入、输出和价格时才计算费用；缓存缺失按全价保守估算。 */
function cost(usage: Usage | undefined, pricing?: ModelPricing): number | null {
  if (!pricing || usage?.prompt_tokens === undefined || usage.completion_tokens === undefined) return null
  const cached = Math.min(usage.prompt_tokens, Math.max(0, cacheReadTokens(usage)))
  return ((usage.prompt_tokens - cached) * pricing.input + cached * (pricing.inputCached ?? pricing.input)
    + usage.completion_tokens * pricing.output) / 1e6
}

/** 三组实验共享总调用和费用上限，调用前按最坏非缓存输入检查。 */
export class EvaluationBudget {
  requests = 0
  estimatedCost = 0
  private reservedCost = 0
  constructor(private maxRequests: number, private maxCost: number, private pricing?: ModelPricing) {}

  /** 限制整批实验，而非每个模式重新获得一份额度。 */
  reserve(request: ChatRequest): Reservation {
    if (this.requests >= this.maxRequests) throw new Error('Evaluation request limit reached')
    const estimate = this.pricing ? (estimateRequestTokens(request.messages, request.tools) * this.pricing.input
      + (request.maxTokens ?? 256) * this.pricing.output) / 1e6 : 0
    if (this.estimatedCost + this.reservedCost + estimate > this.maxCost) throw new Error('Evaluation estimated cost limit reached')
    this.requests++
    this.reservedCost += estimate
    return { estimate, settled: false }
  }

  /** 观测完整用量后的实际估算用于下一次请求检查。 */
  charge(reservation: Reservation, usage?: Usage): void {
    const actual = cost(usage, this.pricing)
    if (reservation.settled || actual === null) return
    reservation.settled = true
    this.reservedCost -= reservation.estimate
    this.estimatedCost += actual
  }
}

/** 父取消与本次超时均能终止等待，迟到响应仍由观察器记录。 */
async function boundedRequest(provider: Provider, request: ChatRequest, timeoutMs: number): Promise<ChatResponse> {
  const controller = new AbortController()
  const cancel = () => controller.abort(request.signal?.reason)
  request.signal?.throwIfAborted()
  request.signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('Evaluation request timed out')), timeoutMs)
  let onAbort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([provider.chat({ ...request, signal: controller.signal }), aborted])
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', onAbort)
    request.signal?.removeEventListener('abort', cancel)
  }
}

/** 按调用观察真实 usage 与摘要分项，缺失任一组成时合计保持未知。 */
export class UsageObserver {
  private observations: Observation[] = []
  constructor(private pricing?: ModelPricing) {}

  /** 包装同一个基础 Provider，不向其暴露场景期望值。 */
  wrap(provider: Provider, budget: EvaluationBudget, timeoutMs: number): Provider {
    return { name: provider.name, chat: async (request) => {
      const reservation = budget.reserve(request)
      const entry: Observation = { summary: isSummaryRequest(request), ms: 0 }
      this.observations.push(entry)
      const started = Date.now()
      try {
        // 观测挂在底层 Promise 上，超时竞争后迟到的用量也能结算。
        const observed: Provider = { name: provider.name, chat: async (forwarded) => {
          const response = await provider.chat(forwarded)
          entry.usage = response.usage
          budget.charge(reservation, response.usage)
          return response
        } }
        return await boundedRequest(observed, request, timeoutMs)
      } finally {
        entry.ms = Date.now() - started
      }
    } }
  }

  /** 返回独立计量结果，未执行的摘要为已知零，缺失 usage 则为 null。 */
  metrics(ms: number): UsageMetrics {
    const all = this.observations
    const summaries = all.filter((entry) => entry.summary)
    const total = (entries: Observation[], select: (entry: Observation) => number | undefined | null): number | null => {
      const values = entries.map(select)
      return values.some((value) => value == null) ? null : values.reduce<number>((sum, value) => sum + value!, 0)
    }
    return { requests: all.length, usageReported: all.filter((entry) => entry.usage !== undefined).length,
      inputTokens: total(all, (entry) => entry.usage?.prompt_tokens),
      outputTokens: total(all, (entry) => entry.usage?.completion_tokens),
      cachedInputTokens: total(all, (entry) => entry.usage?.prompt_cache_hit_tokens ?? entry.usage?.prompt_tokens_details?.cached_tokens
        ?? entry.usage?.cache_read_input_tokens),
      summaryInputTokens: total(summaries, (entry) => entry.usage?.prompt_tokens),
      summaryOutputTokens: total(summaries, (entry) => entry.usage?.completion_tokens),
      estimatedCost: total(all, (entry) => cost(entry.usage, this.pricing)), ms }
  }
}
