import { test, expect } from 'bun:test'
import { PRICING_SNAPSHOT, defaultPricing, resolvePricing } from '../src/pricing.ts'

test('the built-in table covers known ids and provider-prefixed ids', () => {
  expect(defaultPricing('deepseek-chat')).toMatchObject({ input: 0.27, output: 1.1, inputCached: 0.027 })
  expect(defaultPricing('deepseek/deepseek-chat')).toMatchObject({ input: 0.27 })
  expect(defaultPricing('GPT-4O-MINI')).toMatchObject({ input: 0.15 })
  expect(defaultPricing('mystery-model')).toBeUndefined()
  expect(PRICING_SNAPSHOT).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})

test('env overrides win, and unknown models stay unknown', () => {
  expect(resolvePricing('deepseek-chat', { input: 1, output: 2, inputCached: 0.5 })).toEqual({
    input: 1,
    output: 2,
    inputCached: 0.5,
  })
  expect(resolvePricing('mystery-model')).toBeUndefined()
  expect(resolvePricing('mystery-model', { input: 1 })).toBeUndefined() // partial pricing
  expect(resolvePricing('mystery-model', { input: 1, output: 2 })).toMatchObject({ input: 1, output: 2 })
})
