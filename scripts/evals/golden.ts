/**
 * P10 golden set — a labelled set of finished agent outputs, written so a careful
 * human reviewer would agree with each label *without* running a model.
 *
 * This is the honesty fix for the judge: instead of only comparing the judge's
 * verdict against deterministic checks, `calibrate.ts` compares it against these
 * labels. The labels are maintainer-written, not independent human labels, so the
 * resulting "accuracy" measures agreement with our own documented standard — not
 * ground truth. See `calibrate.ts` and the README.
 *
 * Each case carries the exact judge input the runner would build (task prompt +
 * rubric + final answer + artifact contents) and a `rationale` that is evidence,
 * not a restatement of the label. For tasks that also have a deterministic check,
 * the `fail` case is deliberately one that *passes the check* but fails a reason
 * the rubric names (the interesting direction).
 */

export interface GoldenCase {
  id: string
  /** An existing task id in `tasks.ts`. */
  taskId: string
  label: 'pass' | 'fail'
  /** Why this output deserves that label — one or two lines, written for a human reviewer. */
  rationale: string
  answer: string
  artifacts?: Record<string, string>
}

const L = (...ls: string[]): string => ls.join('\n') + '\n'

// ------------------------------------------------------------------ fixtures
// Kept local (rather than exported from tasks.ts) so this file stays independent
// and the artifact contents are exactly what the judge sees.

const PRICING_TEST = L(
  "import { expect, test } from 'bun:test'",
  "import { total } from './pricing.ts'",
  '',
  "test('sums price × qty and adds tax', () => {",
  '  expect(total([{ price: 10, qty: 2 }], 0.1, 0)).toBe(22)',
  '})',
  '',
  "test('applies discount only when subtotal exceeds 100', () => {",
  '  expect(total([{ price: 60, qty: 2 }], 0, 0.1)).toBe(108)',
  '  expect(total([{ price: 10, qty: 2 }], 0, 0.1)).toBe(20)',
  '})',
  '',
  "test('ignores non-positive prices and quantities', () => {",
  '  expect(total([{ price: 5, qty: 3 }, { price: -1, qty: 4 }, { price: 7, qty: 0 }], 0, 0)).toBe(15)',
  '})',
  '',
  "test('rounds to two decimals', () => {",
  '  expect(total([{ price: 0.1, qty: 3 }], 0.1, 0)).toBe(0.33)',
  '})',
  '',
  "test('empty order totals zero', () => {",
  '  expect(total([], 0.2, 0)).toBe(0)',
  '})',
)

const TRANSFORM_SRC = L(
  'export interface Order {',
  '  id: number',
  '  total: number',
  "  status: 'paid' | 'unpaid' | 'refunded'",
  '}',
  '',
  'export function paidTotals(orders: Order[]): number[] {',
  '  const out: number[] = []',
  '  for (let i = 0; i < orders.length; i++) {',
  "    if (orders[i].status === 'paid') {",
  '      out.push(orders[i].total)',
  '    }',
  '  }',
  '  return out',
  '}',
  '',
  'export function topOrders(orders: Order[]): { id: number; total: number }[] {',
  '  const sorted: Order[] = []',
  '  for (let i = 0; i < orders.length; i++) {',
  '    sorted.push(orders[i])',
  '  }',
  '  for (let i = 0; i < sorted.length; i++) {',
  '    for (let j = i + 1; j < sorted.length; j++) {',
  '      if (sorted[j].total > sorted[i].total) {',
  '        const tmp = sorted[i]',
  '        sorted[i] = sorted[j]',
  '        sorted[j] = tmp',
  '      }',
  '    }',
  '  }',
  '  const top: { id: number; total: number }[] = []',
  '  for (let i = 0; i < 3 && i < sorted.length; i++) {',
  '    top.push({ id: sorted[i].id, total: sorted[i].total })',
  '  }',
  '  return top',
  '}',
)

const TRANSFORM_TEST = L(
  "import { expect, test } from 'bun:test'",
  "import { paidTotals, topOrders } from './transform.ts'",
  "import type { Order } from './transform.ts'",
  '',
  'const orders: Order[] = [',
  "  { id: 1, total: 10, status: 'paid' },",
  "  { id: 2, total: 50, status: 'unpaid' },",
  "  { id: 3, total: 30, status: 'paid' },",
  "  { id: 4, total: 5, status: 'refunded' },",
  "  { id: 5, total: 20, status: 'paid' },",
  ']',
  '',
  "test('paidTotals returns totals of paid orders in order', () => {",
  '  expect(paidTotals(orders)).toEqual([10, 30, 20])',
  '})',
  '',
  "test('topOrders returns up to 3 highest totals with ids', () => {",
  '  expect(topOrders(orders)).toEqual([',
  '    { id: 2, total: 50 },',
  '    { id: 3, total: 30 },',
  '    { id: 5, total: 20 },',
  '  ])',
  '})',
  '',
  "test('topOrders handles fewer than 3 orders', () => {",
  "  expect(topOrders([{ id: 1, total: 7, status: 'paid' }])).toEqual([{ id: 1, total: 7 }])",
  '})',
  '',
  "test('handles a larger dataset', () => {",
  '  const big: Order[] = []',
  '  for (let i = 0; i < 1000; i++) {',
  "    big.push({ id: i, total: (i * 37) % 500, status: i % 2 === 0 ? 'paid' : 'unpaid' })",
  '  }',
  '  expect(paidTotals(big).length).toBe(500)',
  '  expect(topOrders(big).length).toBe(3)',
  '})',
)

const GEO_SRC = L(
  'export function circleArea(radius: number): number {',
  "  if (radius < 0) throw new Error('radius must be non-negative')",
  '  return Math.PI * radius * radius',
  '}',
  '',
  'export function distance(x1: number, y1: number, x2: number, y2: number): number {',
  '  return Math.hypot(x2 - x1, y2 - y1)',
  '}',
  '',
  'export function isValidTriangle(a: number, b: number, c: number): boolean {',
  '  return a > 0 && b > 0 && c > 0 && a + b > c && b + c > a && a + c > b',
  '}',
)

const DURATION_CLEAN = L(
  'export function parseDuration(input: string): number {',
  "  if (input === '') {",
  '    throw new Error(`parseDuration: input must not be empty`)',
  '  }',
  '  const units: Record<string, number> = { h: 3600, m: 60, s: 1 }',
  '  const pattern = /([0-9]+)([hms])/g',
  '  let total = 0',
  '  let matched = 0',
  '  let m: RegExpExecArray | null',
  '  while ((m = pattern.exec(input)) !== null) {',
  '    total += Number(m[1]) * units[m[2]]!',
  '    matched = m.index + m[0].length',
  '  }',
  '  if (matched !== input.length) {',
  '    throw new Error(`parseDuration: invalid duration ${JSON.stringify(input)} — expected one or more <number><unit> pairs (h, m, or s)`)',
  '  }',
  '  return total',
  '}',
  '',
  'export function formatDuration(totalSeconds: number): string {',
  '  if (!Number.isInteger(totalSeconds) || totalSeconds < 0) {',
  '    throw new Error(`formatDuration: totalSeconds must be a non-negative integer, got ${totalSeconds}`)',
  '  }',
  "  if (totalSeconds === 0) return '0s'",
  '  const hours = Math.floor(totalSeconds / 3600)',
  '  const minutes = Math.floor((totalSeconds % 3600) / 60)',
  '  const seconds = totalSeconds % 60',
  '  const parts: string[] = []',
  '  if (hours > 0) parts.push(`${hours}h`)',
  '  if (minutes > 0) parts.push(`${minutes}m`)',
  '  if (seconds > 0) parts.push(`${seconds}s`)',
  "  return parts.join(' ')",
  '}',
)

const DURATION_PRINTING = "console.log('[duration] module loaded')\n\n" + DURATION_CLEAN

const PRICING_CLEAN = L(
  'export function total(items: { price: number; qty: number }[], taxRate: number, discount: number): number {',
  '  let subtotal = 0',
  '  for (const item of items) {',
  '    if (item.price > 0 && item.qty > 0) {',
  '      subtotal += item.price * item.qty',
  '    }',
  '  }',
  '  if (subtotal > 100 && discount > 0) {',
  '    subtotal -= subtotal * discount',
  '  }',
  '  if (taxRate > 0) {',
  '    subtotal += subtotal * taxRate',
  '  }',
  '  return Math.round(subtotal * 100) / 100',
  '}',
)

const PRICING_ONELINER =
  'export const total = (items: { price: number; qty: number }[], taxRate: number, discount: number): number => Math.round(((s: number) => (s > 100 && discount > 0 ? s - s * discount : s) * (1 + (taxRate > 0 ? taxRate : 0)))(items.reduce((s, it) => s + (it.price > 0 && it.qty > 0 ? it.price * it.qty : 0), 0)) * 100) / 100\n'

const TRANSFORM_IDIOMATIC = L(
  'export interface Order {',
  '  id: number',
  '  total: number',
  "  status: 'paid' | 'unpaid' | 'refunded'",
  '}',
  '',
  'export function paidTotals(orders: Order[]): number[] {',
  "  return orders.filter((o) => o.status === 'paid').map((o) => o.total)",
  '}',
  '',
  'export function topOrders(orders: Order[]): { id: number; total: number }[] {',
  '  return orders',
  '    .slice()',
  '    .sort((a, b) => b.total - a.total)',
  '    .slice(0, 3)',
  '    .map(({ id, total }) => ({ id, total }))',
  '}',
)

const GEO_MD_GOOD = L(
  '# geo',
  '',
  'Geometry helpers.',
  '',
  '## circleArea(radius: number): number',
  '',
  'Returns the area of a circle with the given radius (`Math.PI * radius * radius`). Throws an `Error` if `radius` is negative.',
  '',
  '## distance(x1: number, y1: number, x2: number, y2: number): number',
  '',
  'Returns the Euclidean distance between `(x1, y1)` and `(x2, y2)`.',
  '',
  '## isValidTriangle(a: number, b: number, c: number): boolean',
  '',
  'Returns `true` when all three sides are positive and satisfy the triangle inequality.',
  '',
  '## Usage',
  '',
  '```ts',
  "import { circleArea, distance, isValidTriangle } from './geo.ts'",
  '',
  'circleArea(2)          // ~12.57',
  'distance(0, 0, 3, 4)   // 5',
  'isValidTriangle(3, 4, 5) // true',
  '```',
)

const GEO_MD_BAD = L(
  '# geo',
  '',
  'Geometry helpers.',
  '',
  '## circleArea(radius, precision)',
  '',
  'Returns the area of a circle, rounded to `precision` decimals (default 2).',
  '',
  '## sphereVolume(radius: number): number',
  '',
  'Returns the volume of a sphere with the given radius.',
  '',
  '## distance(x1, y1, x2, y2): number',
  '',
  'Returns the Euclidean distance between two points.',
  '',
  '## isValidTriangle(a, b, c): boolean',
  '',
  'Returns true when the three sides form a valid triangle.',
)

export const goldenCases: GoldenCase[] = [
  {
    id: 'design-small-api--good',
    taskId: 'design-small-api',
    label: 'pass',
    rationale:
      'Exports exactly the two contracted functions, matches every sample value, throws descriptive Errors on bad input, and contains no top-level console output, extra export, or side effect.',
    answer:
      'Implemented duration.ts with exactly parseDuration and formatDuration. Both throw descriptive Errors on invalid input, the sample cases match the contract, and the module prints nothing and exports nothing else.',
    artifacts: { 'duration.ts': DURATION_CLEAN },
  },
  {
    id: 'design-small-api--bad',
    taskId: 'design-small-api',
    label: 'fail',
    rationale:
      "The two functions are correct and pass every deterministic sample, but the module logs at import time — a side effect the rubric names as an automatic fail ('prints during normal operation').",
    answer:
      'Implemented duration.ts with parseDuration and formatDuration, plus a startup log so users can see when the module loads.',
    artifacts: { 'duration.ts': DURATION_PRINTING },
  },
  {
    id: 'refactor-readability--good',
    taskId: 'refactor-readability',
    label: 'pass',
    rationale:
      'Keeps the name/signature and the subtotal→discount→tax→round order, removes the `s = s ± 0` dead branches, and leaves the test file byte-identical; nothing in the rubric fail list is present.',
    answer:
      'Refactored total() into a single subtotal accumulator: sum price×qty, then discount when subtotal > 100, then tax, then round. Removed the dead s = s ± 0 branches; pricing.test.ts is untouched and bun test passes.',
    artifacts: { 'pricing.ts': PRICING_CLEAN, 'pricing.test.ts': PRICING_TEST },
  },
  {
    id: 'refactor-readability--bad',
    taskId: 'refactor-readability',
    label: 'fail',
    rationale:
      "Behaviour is preserved and the tests pass, but the whole function is one dense nested-expression line — the rubric's mustFail explicitly rejects a rewrite that 'trades clarity for brevity', so this passes the check yet should fail the judge.",
    answer: "Condensed total() to a single expression with no dead branches. pricing.test.ts is untouched and bun test passes.",
    artifacts: { 'pricing.ts': PRICING_ONELINER, 'pricing.test.ts': PRICING_TEST },
  },
  {
    id: 'choose-right-approach--good',
    taskId: 'choose-right-approach',
    label: 'pass',
    rationale:
      'Both functions are rewritten with idiomatic filter/map/sort/slice, keep the exact signatures and return shapes, preserve ordering and top-3 semantics, and the answer names the approach and why nothing heavier was added.',
    answer:
      'Rewrote paidTotals with filter/map and topOrders with slice/sort/slice/map. Behaviour is identical and transform.test.ts is untouched. I used built-in array methods because they are clearer than the hand-rolled loops and need no extra abstraction or dependency.',
    artifacts: { 'transform.ts': TRANSFORM_IDIOMATIC, 'transform.test.ts': TRANSFORM_TEST },
  },
  {
    id: 'choose-right-approach--bad',
    taskId: 'choose-right-approach',
    label: 'fail',
    rationale:
      "Nothing was rewritten, so the deterministic check (test file unchanged + `bun test` passes) would pass — but the rubric's mustFail rejects leaving the manual O(n²) loops untouched, making this a clear fail.",
    answer:
      'Reviewed transform.ts: the existing loops are correct and readable enough, so I left the file unchanged. bun test still passes.',
    artifacts: { 'transform.ts': TRANSFORM_SRC, 'transform.test.ts': TRANSFORM_TEST },
  },
  {
    id: 'explain-a-bug--good',
    taskId: 'explain-a-bug',
    label: 'pass',
    rationale:
      'Identifies the wrong initialisation, gives the exact causal chain (comparison never true → max never reassigned → initial 0 returned), notes 0 is not in the input, and offers a correct fix — with no invented defects.',
    answer:
      'The bug is that maxValue initialises max to 0 instead of the first element. For an all-negative input every comparison nums[i] > max is nums[i] > 0, which is never true, so max is never updated and the initial 0 — a value not in the array — is returned. Fix: start max at nums[0] (guarding the empty case) or at -Infinity.',
    artifacts: {},
  },
  {
    id: 'explain-a-bug--bad',
    taskId: 'explain-a-bug',
    label: 'fail',
    rationale:
      "Restates the symptom and misattributes the cause: the loop does run, it just never reassigns `max`. The rubric fails non-causal explanations with no mechanism and no fix.",
    answer: 'The bug is that the loop never runs for all-negative inputs, so the function falls through and returns its initial value 0.',
    artifacts: {},
  },
  {
    id: 'write-documentation--good',
    taskId: 'write-documentation',
    label: 'pass',
    rationale:
      "Covers all three functions with correct signatures, states the negative-radius throw, and the usage example imports the right names from './geo.ts'; geo.ts is byte-identical.",
    answer:
      "Wrote geo.md documenting circleArea, distance and isValidTriangle with their signatures, return types, the negative-radius throw, and a runnable usage example that imports from './geo.ts'.",
    artifacts: { 'geo.md': GEO_MD_GOOD, 'geo.ts': GEO_SRC },
  },
  {
    id: 'write-documentation--bad',
    taskId: 'write-documentation',
    label: 'fail',
    rationale:
      "Documents `sphereVolume`, a function that does not exist in geo.ts, and misstates `circleArea`'s signature — the rubric's mustFail names invented APIs and wrong signatures as automatic fails.",
    answer: "Wrote geo.md documenting the module's geometry helpers, including sphereVolume.",
    artifacts: { 'geo.md': GEO_MD_BAD, 'geo.ts': GEO_SRC },
  },
]
