/**
 * A small, dated price table for the models this project is normally pointed at.
 *
 * Prices are in USD per 1M tokens and **change**; every value here is overridable
 * with `MICRO_PRICE_INPUT` / `MICRO_PRICE_OUTPUT` / `MICRO_PRICE_INPUT_CACHED`.
 * The snapshot date is part of the contract: when a provider changes prices, bump
 * it and the table rather than silently reporting stale money.
 */

export interface ModelPricing {
  input: number
  output: number
  inputCached?: number
}

export const PRICING_SNAPSHOT = '2026-10-19'

const TABLE: Record<string, ModelPricing> = {
  'deepseek-chat': { input: 0.27, output: 1.1, inputCached: 0.027 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, inputCached: 0.14 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, inputCached: 0.075 },
  'gpt-4o': { input: 2.5, output: 10, inputCached: 1.25 },
}

export function defaultPricing(model: string): ModelPricing | undefined {
  const key = model.trim().toLowerCase()
  if (TABLE[key]) return TABLE[key]
  // Provider-prefixed ids: "deepseek/deepseek-chat", "openai/gpt-4o-mini".
  const tail = key.split('/').pop()
  return tail ? TABLE[tail] : undefined
}

/**
 * Merge env overrides over the built-in table. Returns `undefined` when no price
 * is known at all — callers must treat that as "cost unknown", not as free.
 */
export function resolvePricing(
  model: string,
  overrides: Partial<ModelPricing> = {},
): ModelPricing | undefined {
  const base = defaultPricing(model)
  const input = overrides.input && overrides.input > 0 ? overrides.input : (base?.input ?? 0)
  const output = overrides.output && overrides.output > 0 ? overrides.output : (base?.output ?? 0)
  // Partial pricing would under-report; require both sides.
  if (input <= 0 || output <= 0) return undefined
  const cached = overrides.inputCached && overrides.inputCached > 0 ? overrides.inputCached : base?.inputCached
  return { input, output, ...(cached !== undefined ? { inputCached: cached } : {}) }
}
