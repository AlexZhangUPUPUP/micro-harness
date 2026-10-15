/**
 * P10 eval task set.
 *
 * Two kinds of grading, kept deliberately separate:
 *   - `check`  — a pure predicate over the sandbox after the run (file contents, a
 *                regex over the answer, a command's exit code). No model involved, so
 *                the verdict is reproducible.
 *   - `rubric` — criteria for the LLM judge, for work whose quality has no single
 *                right answer (readability, API design, explanation quality).
 *
 * A task may carry both, which is the most useful case: the deterministic check gates
 * it, and the judge adds quality — and the pair also measures how often the judge
 * agrees with a grader that cannot be wrong.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type Check = (cwd: string) => boolean | Promise<boolean>

export interface SetupFile {
  path: string
  content: string
}

/**
 * A rubric for the LLM judge — used for work whose quality has no single right answer.
 * The judge sees the prompt, the agent's final answer, and the named artifacts; it must
 * answer with strict JSON (`{verdict, score, reasons, violations}`).
 */
export interface Rubric {
  /** The question the judge must decide, in plain language. */
  criteria: string
  /** Concrete requirements; failing any one of them means the verdict is `fail`. */
  mustPass?: string[]
  /** Things whose presence means an automatic `fail`. */
  mustFail?: string[]
  /** Paths (relative to the sandbox) whose contents are handed to the judge. */
  artifacts?: string[]
}

export interface Task {
  id: string
  title: string
  prompt: string
  setup?: SetupFile[]
  /** Deterministic grader: file contents, a regex, or a command's exit code. */
  check?: Check
  /** Quality grader for open-ended work. A task may have both — see `mode`. */
  rubric?: Rubric
  timeoutMs?: number
}

/**
 * `deterministic` (check only) · `judge` (rubric only) · `both` (check gates, judge
 * scores — and the pair doubles as judge calibration data).
 */
export type GradeMode = 'deterministic' | 'judge' | 'both'

export function gradeMode(task: Task): GradeMode {
  if (task.check && task.rubric) return 'both'
  return task.rubric ? 'judge' : 'deterministic'
}

/** Run a shell command in a sandbox dir, with `bun` guaranteed to be on PATH. */
function run(cwd: string, command: string): { code: number; stdout: string; stderr: string } {
  const bunDirs = [path.dirname(process.execPath)]
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home) bunDirs.push(path.join(home, '.bun', 'bin'))
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PATH: `${bunDirs.join(':')}:${process.env.PATH ?? ''}` },
  })
  return { code: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

/** Total read: returns '' when the file is missing or unreadable, so graders never throw. */
function read(cwd: string, rel: string): string {
  try {
    return readFileSync(path.join(cwd, rel), 'utf8')
  } catch {
    return ''
  }
}

function exists(cwd: string, rel: string): boolean {
  return existsSync(path.join(cwd, rel))
}

// ------------------------------------------------------------------ fixtures
// Shared between `setup` and `check` so a grader can assert that a test file is
// still byte-identical to what `setup` wrote.

const PRICING_SRC = `export function total(items: { price: number; qty: number }[], taxRate: number, discount: number): number {
  let s = 0
  let i = 0
  while (i < items.length) {
    const it = items[i]
    if (it.qty > 0) {
      if (it.price > 0) {
        s = s + it.price * it.qty
      } else {
        s = s + 0
      }
    } else {
      s = s + 0
    }
    i = i + 1
  }
  if (s > 100) {
    if (discount > 0) {
      s = s - s * discount
    } else {
      s = s - 0
    }
  } else {
    s = s - 0
  }
  if (taxRate > 0) {
    s = s + s * taxRate
  } else {
    s = s + 0
  }
  const rounded = Math.round(s * 100) / 100
  return rounded
}
`

const PRICING_TEST = `import { expect, test } from 'bun:test'
import { total } from './pricing.ts'

test('sums price × qty and adds tax', () => {
  expect(total([{ price: 10, qty: 2 }], 0.1, 0)).toBe(22)
})

test('applies discount only when subtotal exceeds 100', () => {
  expect(total([{ price: 60, qty: 2 }], 0, 0.1)).toBe(108)
  expect(total([{ price: 10, qty: 2 }], 0, 0.1)).toBe(20)
})

test('ignores non-positive prices and quantities', () => {
  expect(total([{ price: 5, qty: 3 }, { price: -1, qty: 4 }, { price: 7, qty: 0 }], 0, 0)).toBe(15)
})

test('rounds to two decimals', () => {
  expect(total([{ price: 0.1, qty: 3 }], 0.1, 0)).toBe(0.33)
})

test('empty order totals zero', () => {
  expect(total([], 0.2, 0)).toBe(0)
})
`

const TRANSFORM_SRC = `export interface Order {
  id: number
  total: number
  status: 'paid' | 'unpaid' | 'refunded'
}

export function paidTotals(orders: Order[]): number[] {
  const out: number[] = []
  for (let i = 0; i < orders.length; i++) {
    if (orders[i].status === 'paid') {
      out.push(orders[i].total)
    }
  }
  return out
}

export function topOrders(orders: Order[]): { id: number; total: number }[] {
  const sorted: Order[] = []
  for (let i = 0; i < orders.length; i++) {
    sorted.push(orders[i])
  }
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].total > sorted[i].total) {
        const tmp = sorted[i]
        sorted[i] = sorted[j]
        sorted[j] = tmp
      }
    }
  }
  const top: { id: number; total: number }[] = []
  for (let i = 0; i < 3 && i < sorted.length; i++) {
    top.push({ id: sorted[i].id, total: sorted[i].total })
  }
  return top
}
`

const TRANSFORM_TEST = `import { expect, test } from 'bun:test'
import { paidTotals, topOrders } from './transform.ts'
import type { Order } from './transform.ts'

const orders: Order[] = [
  { id: 1, total: 10, status: 'paid' },
  { id: 2, total: 50, status: 'unpaid' },
  { id: 3, total: 30, status: 'paid' },
  { id: 4, total: 5, status: 'refunded' },
  { id: 5, total: 20, status: 'paid' },
]

test('paidTotals returns totals of paid orders in order', () => {
  expect(paidTotals(orders)).toEqual([10, 30, 20])
})

test('topOrders returns up to 3 highest totals with ids', () => {
  expect(topOrders(orders)).toEqual([
    { id: 2, total: 50 },
    { id: 3, total: 30 },
    { id: 5, total: 20 },
  ])
})

test('topOrders handles fewer than 3 orders', () => {
  expect(topOrders([{ id: 1, total: 7, status: 'paid' }])).toEqual([{ id: 1, total: 7 }])
})

test('handles a larger dataset', () => {
  const big: Order[] = []
  for (let i = 0; i < 1000; i++) {
    big.push({ id: i, total: (i * 37) % 500, status: i % 2 === 0 ? 'paid' : 'unpaid' })
  }
  expect(paidTotals(big).length).toBe(500)
  expect(topOrders(big).length).toBe(3)
})
`

export const tasks: Task[] = [
  {
    id: 'exact-file',
    title: 'Create a file with exact content',
    prompt:
      'Create a file named `hello.txt` whose entire content is exactly `hello, micro-harness` followed by a single newline. No other bytes and no extra spaces.',
    check: (cwd) => exists(cwd, 'hello.txt') && read(cwd, 'hello.txt') === 'hello, micro-harness\n',
  },
  {
    id: 'fix-failing-test',
    title: 'Fix a bug so `bun test` passes',
    timeoutMs: 120_000,
    setup: [
      { path: 'sum.ts', content: 'export function sum(a: number, b: number): number {\n  return a - b\n}\n' },
      {
        path: 'sum.test.ts',
        content:
          "import { expect, test } from 'bun:test'\nimport { sum } from './sum.ts'\n\ntest('sum adds two numbers', () => {\n  expect(sum(2, 3)).toBe(5)\n})\n",
      },
    ],
    prompt:
      'Run `bun test` in the workspace; it currently fails. Find the bug in `sum.ts` and fix it so the tests pass. Do not modify `sum.test.ts`.',
    check: (cwd) => {
      const r = run(cwd, 'bun test')
      return r.code === 0 && read(cwd, 'sum.ts').includes('return a + b') && read(cwd, 'sum.test.ts').includes('toBe(5)')
    },
  },
  {
    id: 'rename-symbol',
    title: 'Rename a symbol across two files',
    setup: [
      { path: 'lib.ts', content: 'export function oldName(x: number): number {\n  return x * 2\n}\n' },
      {
        path: 'main.ts',
        content: "import { oldName } from './lib.ts'\n\nconst result = oldName(21)\nconsole.log(result)\n",
      },
    ],
    prompt:
      'Rename the exported function `oldName` to `doubled` across the workspace: update its definition in `lib.ts` and every use in `main.ts`. No reference to `oldName` may remain.',
    check: (cwd) => {
      const lib = read(cwd, 'lib.ts')
      const main = read(cwd, 'main.ts')
      return (
        lib.includes('export function doubled') &&
        !lib.includes('oldName') &&
        main.includes('doubled') &&
        !main.includes('oldName')
      )
    },
  },
  {
    id: 'json-shape',
    title: 'Produce a JSON file with a specific shape',
    prompt:
      'Create `config.json` containing a single JSON object with exactly these four keys: `name` (a string), `port` (an integer between 1024 and 65535), `retries` (a non-negative integer), `enabled` (a boolean). Valid JSON only — no comments, no trailing commas.',
    check: (cwd) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(read(cwd, 'config.json'))
      } catch {
        return false
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
      const obj = parsed as Record<string, unknown>
      if (Object.keys(obj).length !== 4) return false
      if (typeof obj.name !== 'string') return false
      if (typeof obj.port !== 'number' || !Number.isInteger(obj.port) || obj.port < 1024 || obj.port > 65535) return false
      if (typeof obj.retries !== 'number' || !Number.isInteger(obj.retries) || obj.retries < 0) return false
      if (typeof obj.enabled !== 'boolean') return false
      return true
    },
  },
  {
    id: 'flip-flag',
    title: 'Find and change one line',
    setup: [{ path: 'settings.env', content: 'PORT=8080\nDEBUG=false\nLOG_LEVEL=info\n' }],
    prompt:
      'In `settings.env`, find the line that sets the debug flag and change its value to `true`. Leave every other line exactly as it is.',
    check: (cwd) => {
      const c = read(cwd, 'settings.env').replace(/\r\n/g, '\n')
      return c === 'PORT=8080\nDEBUG=true\nLOG_LEVEL=info\n' || c === 'PORT=8080\nDEBUG=true\nLOG_LEVEL=info'
    },
  },
  {
    id: 'read-and-write',
    title: 'Read a file, then write what it says',
    setup: [{ path: 'clue.txt', content: 'serendipity\n' }],
    prompt:
      'Read `clue.txt`; it contains a single word. Write that exact word (no surrounding whitespace or punctuation) into a new file `result.txt`.',
    check: (cwd) => exists(cwd, 'result.txt') && read(cwd, 'result.txt').trim() === 'serendipity',
  },
  {
    id: 'append-section',
    title: 'Append without breaking existing content',
    setup: [{ path: 'notes.md', content: '# Project Notes\n\nSome existing content.\n' }],
    prompt:
      'Append a new section titled `## Changelog` to the end of `notes.md`, containing the bullet `- 2025-01-01: first release`. Do not modify or delete any of the existing content.',
    check: (cwd) => {
      const content = read(cwd, 'notes.md')
      return (
        content.startsWith('# Project Notes\n\nSome existing content.\n') &&
        content.includes('## Changelog') &&
        content.includes('- 2025-01-01: first release')
      )
    },
  },
  {
    id: 'hello-run',
    title: 'Make `bun run` print the right thing',
    timeoutMs: 120_000,
    setup: [{ path: 'hello.ts', content: "console.log('Goodbye, world!')\n" }],
    prompt:
      "The file `hello.ts` should print exactly `Hello, world!` when run with `bun run hello.ts`. Fix it, then verify by running it.",
    check: (cwd) => {
      const r = run(cwd, 'bun run hello.ts')
      return r.code === 0 && r.stdout.trim() === 'Hello, world!'
    },
  },
  {
    id: 'surgical-edit',
    title: 'Change one value without reformatting the file',
    setup: [
      {
        path: 'server.toml',
        content:
          '[server]\nhost = "0.0.0.0"\nport = 8080\nworkers = 2\n\n[logging]\nlevel = "info"\nformat = "json"\n',
      },
    ],
    prompt:
      'In `server.toml`, change only the `workers` value under the `[server]` section from `2` to `4`. Do not reformat, reorder, add, or remove any other line or character — every other byte of the file must remain exactly as it is.',
    check: (cwd) => {
      const expected =
        '[server]\nhost = "0.0.0.0"\nport = 8080\nworkers = 4\n\n[logging]\nlevel = "info"\nformat = "json"\n'
      return read(cwd, 'server.toml').replace(/\r\n/g, '\n') === expected
    },
  },
  {
    id: 'extend-module',
    title: 'Append and export a new function to a module',
    timeoutMs: 120_000,
    setup: [{ path: 'math.ts', content: 'export function double(x: number): number {\n  return x * 2\n}\n' }],
    prompt:
      "Add a new exported function named `triple` to `math.ts`. It must take one number and return that number multiplied by 3. Keep the existing `double` function exactly as it is, and keep the module importable with `import { triple } from './math.ts'`.",
    check: (cwd) => {
      const r = run(
        cwd,
        `bun -e "import('./math.ts').then(m => { if (m.double(5) !== 10) { console.error('double'); process.exit(1) } if (m.triple(5) !== 15) { console.error('triple'); process.exit(1) } if (m.triple(7) !== 21) { console.error('triple7'); process.exit(1) } console.log('ok') }).catch(e => { console.error(String(e)); process.exit(1) })"`,
      )
      return r.code === 0 && r.stdout.includes('ok')
    },
  },
  {
    id: 'delete-file',
    title: 'Delete a file and leave its sibling untouched',
    setup: [
      { path: 'stale.txt', content: 'delete me\n' },
      { path: 'keep.txt', content: 'do not touch\n' },
    ],
    prompt:
      'Delete the file `stale.txt`. Leave `keep.txt` exactly as it is: still present, with the same contents and no extra bytes.',
    check: (cwd) => !exists(cwd, 'stale.txt') && read(cwd, 'keep.txt') === 'do not touch\n',
  },
  {
    id: 'fix-package-script',
    title: 'Fix a broken `package.json` script',
    timeoutMs: 120_000,
    setup: [
      {
        path: 'package.json',
        content: '{\n  "name": "greeter",\n  "version": "1.0.0",\n  "scripts": {\n    "start": "bun run greet.tss"\n  }\n}\n',
      },
      { path: 'greet.ts', content: "console.log('Hello, config!')\n" },
    ],
    prompt:
      "Run `bun run start` — it fails because the `start` script in `package.json` references `greet.tss` (a typo for `greet.ts`). Fix only that typo in `package.json` so `bun run start` succeeds and prints exactly `Hello, config!`. Do not modify `greet.ts`.",
    check: (cwd) => {
      const r = run(cwd, 'bun run start')
      if (r.code !== 0 || r.stdout.trim() !== 'Hello, config!') return false
      if (read(cwd, 'greet.ts') !== "console.log('Hello, config!')\n") return false
      const rawPkg = read(cwd, 'package.json')
      if (rawPkg.includes('greet.tss')) return false
      try {
        const pkg = JSON.parse(rawPkg) as { scripts?: { start?: string } }
        return (pkg.scripts?.start ?? '').includes('greet.ts')
      } catch {
        return false
      }
    },
  },
  {
    id: 'refactor-readability',
    title: 'Refactor an ugly function without changing behaviour',
    timeoutMs: 120_000,
    setup: [
      { path: 'pricing.ts', content: PRICING_SRC },
      { path: 'pricing.test.ts', content: PRICING_TEST },
    ],
    prompt:
      '`pricing.ts` exports `total`, which works but is written with redundant branches and dead code. Refactor it to be clearly simpler and easier to read while keeping its exact external behaviour (same name, signature, and results). `bun test` must still pass. Do not modify `pricing.test.ts` and do not add any dependency.',
    check: (cwd) => {
      if (read(cwd, 'pricing.test.ts') !== PRICING_TEST) return false
      const r = run(cwd, 'bun test')
      return r.code === 0
    },
    rubric: {
      criteria:
        'Judge whether the refactor preserves the external behaviour of `total` while genuinely improving readability.',
      mustPass: [
        '`total` keeps the same exported name and signature `(items, taxRate, discount): number`',
        'the rewrite computes subtotal, then discount only when subtotal > 100, then tax, then rounds to 2 decimals',
        'redundant branches and dead code (`s = s + 0`, `s = s - 0`) are removed',
        '`bun test` passes with the original test file untouched',
        'no new dependency, file, or exported symbol was introduced',
      ],
      mustFail: [
        'changed the exported name, parameter order, or return type',
        'modified `pricing.test.ts` to make it pass',
        'changed numeric behaviour (discount threshold, rounding, or which items are summed)',
        'added a dependency or import from an external package',
        'rewrote the function as an unreadable one-liner that trades clarity for brevity',
      ],
      artifacts: ['pricing.ts', 'pricing.test.ts'],
    },
  },
  {
    id: 'explain-a-bug',
    title: 'Explain a subtle bug without fixing it',
    setup: [
      {
        path: 'max.ts',
        content:
          'export function maxValue(nums: number[]): number {\n  let max = 0\n  for (let i = 0; i < nums.length; i++) {\n    if (nums[i] > max) {\n      max = nums[i]\n    }\n  }\n  return max\n}\n',
      },
    ],
    prompt:
      '`max.ts` has a subtle bug: `maxValue([-5, -2, -9])` returns `0`, which is not in the input array. Do NOT modify `max.ts` or create any other file. In your final answer, explain: (1) what the bug is, (2) the exact causal reason it returns `0` for all-negative inputs, and (3) how it should be fixed. Stay focused on this one defect.',
    rubric: {
      criteria:
        'Does the explanation correctly identify the bug and its causal mechanism, without inventing unrelated problems?',
      mustPass: [
        'identifies that `max` is initialised to `0`, which is greater than every element of an all-negative array',
        'explains the causal chain: the comparison `nums[i] > max` is never true for negatives, so `max` is never updated and the initial `0` is returned',
        'notes that `0` is not a member of the input, so the returned value cannot come from the array',
        'describes a correct fix (e.g. initialise from `nums[0]` and handle the empty case, or start at `-Infinity`)',
        'leaves `max.ts` unmodified and creates no files',
      ],
      mustFail: [
        'modified `max.ts` or created files',
        'attributes the bug to an unrelated cause (e.g. claims the loop never runs)',
        'invents additional bugs that are not present',
        'gives a non-causal restatement with no mechanism (merely restates that 0 is returned)',
      ],
      artifacts: [],
    },
  },
  {
    id: 'design-small-api',
    title: 'Implement a small API from a contract',
    timeoutMs: 120_000,
    prompt:
      'Implement a new module `duration.ts` exporting exactly two functions:\n' +
      '- `parseDuration(input: string): number` — parses strings made of one or more `<number><unit>` pairs where unit is `h`, `m`, or `s` (e.g. `90s`, `5m`, `2h`, `1h30m`) and returns the total number of seconds. Throw an `Error` for an empty string, an unknown unit, or a missing number/unit.\n' +
      '- `formatDuration(totalSeconds: number): string` — the inverse: returns e.g. `45s`, `2m 15s`, or `1h 30m`, omitting any unit whose value is zero, with single spaces between units; `formatDuration(0)` returns `0s`. Throw an `Error` if the input is negative or not an integer.\n' +
      'Export nothing else, choose clear names (the contract fixes the two above), fail loudly on bad input, and do not print anything.',
    check: (cwd) => {
      const r = run(
        cwd,
        `bun -e "import('./duration.ts').then(m => { const keys = Object.keys(m).sort(); if (keys.join(',') !== 'formatDuration,parseDuration') { console.error('exports: ' + keys.join(',')); process.exit(1) } if (m.parseDuration('1h30m') !== 5400) { console.error('p1'); process.exit(1) } if (m.parseDuration('90s') !== 90) { console.error('p2'); process.exit(1) } if (m.parseDuration('2m15s') !== 135) { console.error('p3'); process.exit(1) } if (m.formatDuration(5400) !== '1h 30m') { console.error('f1: ' + m.formatDuration(5400)); process.exit(1) } if (m.formatDuration(45) !== '45s') { console.error('f2'); process.exit(1) } if (m.formatDuration(0) !== '0s') { console.error('f3'); process.exit(1) } for (const bad of ['abc', '', '10x']) { let threw = false; try { m.parseDuration(bad) } catch (e) { threw = e instanceof Error } if (!threw) { console.error('parse no throw: ' + bad); process.exit(1) } } for (const bad of [-1, 1.5]) { let threw = false; try { m.formatDuration(bad) } catch (e) { threw = e instanceof Error } if (!threw) { console.error('format no throw: ' + bad); process.exit(1) } } console.log('ok') }).catch(e => { console.error(String(e)); process.exit(1) })"`,
      )
      return r.code === 0 && r.stdout.includes('ok')
    },
    rubric: {
      criteria:
        'Assess the API design: are the two functions well-named, easy to call, and do they fail loudly and clearly on bad input?',
      mustPass: [
        'exports exactly `parseDuration` and `formatDuration` and nothing else',
        'argument order and types match the contract (string in / number out; number in / string out)',
        'invalid input (empty, unknown unit, non-numeric, negative, non-integer) throws an `Error` rather than returning `NaN`/`0`/`undefined`',
        "the sample cases behave exactly: `parseDuration('1h30m') === 5400`, `formatDuration(5400) === '1h 30m'`, `formatDuration(0) === '0s'`",
        'no console output, global side effects, or extra files required to run',
      ],
      mustFail: [
        'exported helpers or extra names beyond the two functions',
        'swapped or ambiguous argument order (e.g. `parseDuration` returning a string)',
        'silent failure on bad input (returning `NaN`/`0`/`undefined` instead of throwing)',
        'added a dependency or required a separate config file',
        'prints during normal operation',
      ],
      artifacts: ['duration.ts'],
    },
  },
  {
    id: 'write-documentation',
    title: 'Document an existing module accurately',
    setup: [
      {
        path: 'geo.ts',
        content:
          'export function circleArea(radius: number): number {\n  if (radius < 0) throw new Error(\'radius must be non-negative\')\n  return Math.PI * radius * radius\n}\n\nexport function distance(x1: number, y1: number, x2: number, y2: number): number {\n  return Math.hypot(x2 - x1, y2 - y1)\n}\n\nexport function isValidTriangle(a: number, b: number, c: number): boolean {\n  return a > 0 && b > 0 && c > 0 && a + b > c && b + c > a && a + c > b\n}\n',
      },
    ],
    prompt:
      "Write a `geo.md` file documenting the module `geo.ts`. For each exported function, state its inputs, outputs, and any error behaviour, and include at least one usage example that would actually run under Bun (`import { ... } from './geo.ts'`). Be terse and accurate — do not invent functions, options, or behaviour that do not exist, and do not modify `geo.ts`.",
    rubric: {
      criteria:
        'Is the documentation accurate, complete, and terse, with a usage example that would actually run?',
      mustPass: [
        'documents all three exported functions (`circleArea`, `distance`, `isValidTriangle`) with correct parameters and return types',
        'states that `circleArea` throws an `Error` for a negative radius',
        "the usage example imports from './geo.ts' with the correct names and calls each function with the correct number of arguments",
        'contains no invented functions, parameters, or options',
        'is terse (no filler), and `geo.ts` is unchanged',
      ],
      mustFail: [
        'invented APIs (functions/options not in `geo.ts`) or wrong signatures',
        'a usage example that would not run (wrong import path, wrong names, wrong argument counts)',
        'omitted a function or misstated return types',
        'modified `geo.ts`',
        'replaced the documentation with a full source-code dump instead of describing the API',
      ],
      artifacts: ['geo.md', 'geo.ts'],
    },
  },
  {
    id: 'add-validation',
    title: 'Add validation with descriptive errors',
    timeoutMs: 120_000,
    setup: [
      {
        path: 'config.ts',
        content:
          'export interface Config {\n  host: string\n  port: number\n  debug: boolean\n}\n\nexport function parseConfig(raw: string): Config {\n  const lines = raw.split(\'\\n\').filter((l) => l.trim() !== \'\')\n  const cfg: Record<string, string> = {}\n  for (const line of lines) {\n    const [key, value] = line.split(\'=\')\n    cfg[key.trim()] = value.trim()\n  }\n  return {\n    host: cfg.host.trim(),\n    port: parseInt(cfg.port.trim(), 10),\n    debug: cfg.debug === \'true\',\n  }\n}\n',
      },
    ],
    prompt:
      '`config.ts` exports `parseConfig(raw: string): Config`. Right now it fails badly on invalid input: a non-numeric `port` silently produces `NaN`, and a missing `host` throws a bare `TypeError`. Improve `parseConfig` so invalid input throws a descriptive `Error` whose message says what was wrong and what was expected (naming the offending key). Keep the valid path exactly the same: do not change the `Config` shape, the function name/signature, or the result for well-formed input. Do not add dependencies.',
    check: (cwd) => {
      const r = run(
        cwd,
        `bun -e "const nl = String.fromCharCode(10); import('./config.ts').then(m => { const p = m.parseConfig; const ok = p(['host=localhost','port=8080','debug=true'].join(nl)); if (ok.host !== 'localhost' || ok.port !== 8080 || ok.debug !== true) { console.error('valid changed'); process.exit(1) } let e1 = null; try { p(['host=localhost','port=abc','debug=true'].join(nl)) } catch (e) { e1 = e } if (!(e1 instanceof Error) || !/port/i.test(e1.message)) { console.error('port=abc should throw naming port'); process.exit(1) } let e2 = null; try { p(['port=8080','debug=true'].join(nl)) } catch (e) { e2 = e } if (!(e2 instanceof Error) || !/host/i.test(e2.message)) { console.error('missing host should throw naming host'); process.exit(1) } let e3 = null; try { p(['host=localhost','debug=true','oops'].join(nl)) } catch (e) { e3 = e } if (!(e3 instanceof Error) || e3 instanceof TypeError || e3.message.trim() === '') { console.error('a line without = must raise a descriptive Error, not leak a TypeError'); process.exit(1) } console.log('ok') }).catch(e => { console.error(String(e)); process.exit(1) })"`,
      )
      return r.code === 0 && r.stdout.includes('ok')
    },
    rubric: {
      criteria:
        'Does the added validation fail loudly and clearly on bad input while leaving the valid path untouched?',
      mustPass: [
        '`parseConfig` keeps its name, signature, and returns `{ host, port, debug }` for valid input',
        'a non-numeric `port` throws an `Error` (not `NaN`) whose message names `port` and says what was expected',
        'a missing `host` throws an `Error` whose message names `host`',
        'other malformed input (e.g. a line without `=`) throws a descriptive `Error` rather than a bare `TypeError`',
        'no new dependency, file, or change to the `Config` shape',
      ],
      mustFail: [
        'changed the function name/signature or the `Config` shape',
        'silently returns `NaN`/`undefined`/`false` for bad input instead of throwing',
        'throws a bare `TypeError` (e.g. undefined is not a function) without a descriptive message',
        'changed the result for well-formed input',
        'added a dependency',
      ],
      artifacts: ['config.ts'],
    },
  },
  {
    id: 'choose-right-approach',
    title: 'Choose the right approach for a slow rewrite',
    timeoutMs: 120_000,
    setup: [
      { path: 'transform.ts', content: TRANSFORM_SRC },
      { path: 'transform.test.ts', content: TRANSFORM_TEST },
    ],
    prompt:
      '`transform.ts` works but is written as slow, hand-rolled loops: `paidTotals` filters with an index loop and `topOrders` does a manual O(n²) sort and manual slice. Rewrite both functions in a clearer, more idiomatic style (for example using `filter`/`map`/`sort`/`slice`). Keep their exact external behaviour, including argument order and return shapes. `bun test` must still pass — do not modify `transform.test.ts`. In your final answer, briefly justify the approach you chose and why you avoided over-engineering (no new abstractions or dependencies).',
    check: (cwd) => {
      if (read(cwd, 'transform.test.ts') !== TRANSFORM_TEST) return false
      const r = run(cwd, 'bun test')
      return r.code === 0
    },
    rubric: {
      criteria:
        'Did the agent choose a reasonable, idiomatic approach, justify it, and avoid over-engineering?',
      mustPass: [
        'keeps the exact exported names, signatures, and return shapes (`paidTotals(Order[]): number[]`, `topOrders(Order[]): { id, total }[]`)',
        'uses idiomatic array methods (e.g. `filter`, `map`, `sort`, `slice`) instead of equivalent hand-rolled loops',
        'behaviour is unchanged: `paidTotals` keeps the original order of paid orders; `topOrders` returns up to 3 highest totals with their ids',
        'the final answer states which approach was used and why, in one or two sentences',
        'no new dependency, no new file, and no extra exported helper was added',
      ],
      mustFail: [
        'changed the function names, signatures, or return shapes',
        'modified `transform.test.ts`',
        'added a dependency or a new abstraction (class, framework) for a task this size',
        'left the manual O(n²) loops untouched instead of rewriting them',
        'changed observable behaviour (order, filtering, or top-3 semantics)',
      ],
      artifacts: ['transform.ts', 'transform.test.ts'],
    },
  },
  {
    id: 'extract-constant',
    title: 'Extract a repeated literal into a named constant',
    setup: [
      {
        path: 'physics.ts',
        content:
          'export function fallTime(height: number): number {\n  return Math.sqrt((2 * height) / 9.80665)\n}\n\nexport function impactSpeed(height: number): number {\n  return Math.sqrt(2 * 9.80665 * height)\n}\n',
      },
    ],
    prompt:
      "The file `physics.ts` repeats the literal `9.80665` (standard gravity in m/s²) in two places. Extract it into a single exported constant named `GRAVITY` and replace both uses with it. The module must still compile and behave identically.",
    check: (cwd) => {
      const src = read(cwd, 'physics.ts')
      const occurrences = (src.match(/9\.80665/g) ?? []).length
      if (!src.includes('export const GRAVITY') || occurrences !== 1) return false
      if (!src.includes('fallTime') || !src.includes('impactSpeed')) return false
      const r = run(
        cwd,
        `bun -e "import('./physics.ts').then(m => { if (m.GRAVITY !== 9.80665) { console.error('GRAVITY'); process.exit(1) } if (Math.abs(m.fallTime(10) - Math.sqrt(20 / 9.80665)) > 1e-9) { console.error('fallTime'); process.exit(1) } if (Math.abs(m.impactSpeed(10) - Math.sqrt(2 * 9.80665 * 10)) > 1e-9) { console.error('impactSpeed'); process.exit(1) } console.log('ok') }).catch(e => { console.error(String(e)); process.exit(1) })"`,
      )
      return r.code === 0 && r.stdout.includes('ok')
    },
  },
  {
    id: 'fix-off-by-one',
    title: 'Fix an off-by-one caught by a test',
    timeoutMs: 120_000,
    setup: [
      {
        path: 'range.ts',
        content:
          'export function range(n: number): number[] {\n  const out: number[] = []\n  for (let i = 0; i <= n; i++) {\n    out.push(i)\n  }\n  return out\n}\n',
      },
      {
        path: 'range.test.ts',
        content:
          "import { expect, test } from 'bun:test'\nimport { range } from './range.ts'\n\ntest('range(5) has exactly 5 numbers 0..4', () => {\n  expect(range(5)).toEqual([0, 1, 2, 3, 4])\n})\n",
      },
    ],
    prompt:
      "Run `bun test`; it fails because `range(n)` returns `n + 1` numbers instead of `n`. Fix the off-by-one in `range.ts` so `bun test` passes. Do not modify `range.test.ts`.",
    check: (cwd) => {
      const src = read(cwd, 'range.ts')
      if (src.includes('i <= n')) return false
      if (!read(cwd, 'range.test.ts').includes('toEqual([0, 1, 2, 3, 4])')) return false
      const r = run(cwd, 'bun test')
      return r.code === 0
    },
  },
  {
    id: 'add-test-case',
    title: 'Add a test that must pass',
    timeoutMs: 120_000,
    setup: [
      { path: 'parity.ts', content: 'export function isEven(n: number): boolean {\n  return n % 2 === 0\n}\n' },
    ],
    prompt:
      "Write a new test file `parity.test.ts` that imports `isEven` from './parity.ts' and asserts at least these three cases: `isEven(4)` is true, `isEven(7)` is false, and `isEven(0)` is true. Run `bun test`; it must pass.",
    check: (cwd) => {
      const t = read(cwd, 'parity.test.ts')
      if (!t.includes("from './parity.ts'")) return false
      if (!t.includes('isEven(4)') || !t.includes('isEven(7)') || !t.includes('isEven(0)')) return false
      const r = run(cwd, 'bun test')
      return r.code === 0
    },
  },
  {
    id: 'idempotent-script',
    title: 'Make a script idempotent',
    timeoutMs: 120_000,
    setup: [
      { path: 'log.txt', content: 'session=started\n' },
      {
        path: 'log.ts',
        content:
          "import { appendFileSync } from 'node:fs'\n\nappendFileSync('log.txt', 'marker=present\\n')\n",
      },
    ],
    prompt:
      "The script `log.ts` appends a `marker=present` line to `log.txt` every time it runs, so repeated runs duplicate that line. Make it idempotent: running `bun log.ts` any number of times must leave `log.txt` containing each distinct line exactly once (no duplicates). Verify by running the script twice.",
    check: (cwd) => {
      run(cwd, 'bun log.ts')
      const first = read(cwd, 'log.txt')
      run(cwd, 'bun log.ts')
      const second = read(cwd, 'log.txt')
      if (first === '' || first !== second) return false
      const markers = (second.match(/marker=present/g) ?? []).length
      return markers === 1 && second.includes('session=started')
    },
  },
  {
    id: 'simplify-error-handling',
    title: 'Simplify redundant error handling without changing behaviour',
    timeoutMs: 120_000,
    setup: [
      {
        path: 'retry.ts',
        content:
          "export function load(paths: string[]): string {\n  let last: unknown = null\n  for (const p of paths) {\n    try {\n      try {\n        try {\n          return readText(p)\n        } catch (e) {\n          last = e\n        }\n      } catch (e) {\n        last = e\n      }\n    } catch (e) {\n      last = e\n    }\n  }\n  throw new Error('load: all paths failed: ' + String(last))\n}\n\nfunction readText(path: string): string {\n  if (path === 'ok.txt') return 'loaded'\n  throw new Error('no such file: ' + path)\n}\n",
      },
      {
        path: 'retry.test.ts',
        content:
          "import { expect, test } from 'bun:test'\nimport { load } from './retry.ts'\n\ntest('returns first successful path', () => {\n  expect(load(['ok.txt'])).toBe('loaded')\n  expect(load(['missing.txt', 'ok.txt'])).toBe('loaded')\n})\n\ntest('throws a single aggregated error when all fail', () => {\n  let threw: unknown\n  try { load(['a.txt', 'b.txt']) } catch (e) { threw = e }\n  expect(threw).toBeInstanceOf(Error)\n  expect(String((threw as Error).message)).toContain('all paths failed')\n})\n",
      },
    ],
    prompt:
      '`retry.ts` exports `load(paths)` which works but wraps each read attempt in three redundant nested try/catch blocks that all do the same thing. Simplify the error handling to a single try/catch per path while keeping the exact behaviour (first successful path wins, otherwise a single aggregated error). Do not modify `retry.test.ts`; `bun test` must still pass.',
    check: (cwd) => {
      if (!read(cwd, 'retry.test.ts').includes("'all paths failed'")) return false
      const r = run(cwd, 'bun test')
      return r.code === 0
    },
    rubric: {
      criteria:
        'Is the error handling simplified to a single try/catch per path while the exact try-each-path-then-throw behaviour is preserved?',
      mustPass: [
        'keeps `load(paths: string[]): string` with the first-success-wins semantics',
        'reduces the three nested try/catch blocks to a single try/catch per path',
        "still throws a single aggregated `Error` (message includes 'all paths failed') when every path fails",
        '`bun test` passes with retry.test.ts untouched',
        'no new dependency, file, or exported symbol',
      ],
      mustFail: [
        'swallowed an error silently (e.g. returned undefined instead of throwing when all fail)',
        'changed the success/failure behaviour (wrong return value or wrong throw)',
        'modified retry.test.ts',
        'added a dependency or an unrelated abstraction',
        'left the redundant nesting in place (no actual simplification)',
      ],
      artifacts: ['retry.ts', 'retry.test.ts'],
    },
  },
  {
    id: 'split-long-function',
    title: 'Split a long function into clearly-named helpers',
    timeoutMs: 120_000,
    setup: [
      {
        path: 'report.ts',
        content:
          "export function summarize(rows: { name: string; amount: number }[]): string {\n  let total = 0\n  let count = 0\n  for (const r of rows) {\n    if (r.amount > 0) {\n      total = total + r.amount\n      count = count + 1\n    }\n  }\n  let average = 0\n  if (count > 0) {\n    average = total / count\n  }\n  let names: string[] = []\n  for (const r of rows) {\n    if (r.amount > 100) {\n      names.push(r.name)\n    }\n  }\n  names = names.sort()\n  const lines: string[] = []\n  lines.push('total: ' + total.toFixed(2))\n  lines.push('count: ' + count)\n  lines.push('average: ' + average.toFixed(2))\n  lines.push('large: ' + (names.length ? names.join(', ') : 'none'))\n  return lines.join('\\n')\n}\n",
      },
      {
        path: 'report.test.ts',
        content:
          "import { expect, test } from 'bun:test'\nimport { summarize } from './report.ts'\n\nconst rows = [\n  { name: 'a', amount: 50 },\n  { name: 'b', amount: 150 },\n  { name: 'c', amount: -10 },\n]\n\ntest('summarize computes total, count, average, and large names', () => {\n  const out = summarize(rows)\n  expect(out).toContain('total: 200.00')\n  expect(out).toContain('count: 2')\n  expect(out).toContain('average: 100.00')\n  expect(out).toContain('large: b')\n})\n",
      },
    ],
    prompt:
      '`report.ts` exports `summarize(rows)`, one long function that computes a total, a count, an average, and a list of large names all inline. Split it into small, clearly-named helper functions (for example one per computation) while keeping the exact output. Do not modify `report.test.ts`; `bun test` must still pass. In your final answer, name the helpers you introduced and what each does.',
    check: (cwd) => {
      if (!read(cwd, 'report.test.ts').includes("'large: b'")) return false
      const r = run(cwd, 'bun test')
      return r.code === 0
    },
    rubric: {
      criteria:
        'Did the agent split the long function into small, clearly-named helpers with unchanged behaviour?',
      mustPass: [
        'keeps `summarize` name/signature and byte-identical output for the given inputs',
        'splits the computation into at least 3 separate, descriptively named helper functions (e.g. total, average, largeNames)',
        'each helper has a single clear responsibility and the original inline logic is removed',
        '`bun test` passes with report.test.ts untouched',
        'the final answer names the helpers and their responsibilities',
      ],
      mustFail: [
        'left `summarize` as one long function (no real split)',
        'changed the output format or the numbers',
        'modified report.test.ts',
        'introduced a class, framework, or dependency for a task this size',
        'added dead helpers that are never used',
      ],
      artifacts: ['report.ts', 'report.test.ts'],
    },
  },
  {
    id: 'write-commit-message',
    title: 'Write a conventional commit message for a diff',
    setup: [
      {
        path: 'change.diff',
        content:
          "diff --git a/src/retry.ts b/src/retry.ts\nindex 0000000..1111111 100644\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1,8 +1,8 @@\n export function fetchWithRetry(url: string, attempts: number): Promise<Response> {\n-  const delay = attempts * 100\n+  const delay = Math.min(attempts * 100, 2000)\n   for (let i = 0; i < attempts; i++) {\n     try {\n       return fetch(url)\n     } catch (e) {\n-      await new Promise(r => setTimeout(r, delay))\n+      await new Promise(r => setTimeout(r, delay * (i + 1)))\n     }\n   }\n   throw new Error('fetchWithRetry: all attempts failed')\n }\n",
      },
    ],
    prompt:
      'A teammate changed `src/retry.ts` and attached this diff (`change.diff`). Write a conventional commit message for it: a one-line subject (≤ 72 chars, imperative mood) plus a short body explaining what changed and why. Save it to `COMMIT_MSG.md` and repeat the message in your final answer.',
    rubric: {
      criteria:
        'Is the commit message a correct, conventional summary of the diff — imperative subject plus a body that explains the what and the why?',
      mustPass: [
        'subject is imperative, ≤ 72 characters, and summarises the change (retry backoff is now capped and scaled by attempt)',
        'body explains what changed (delay capped at 2000ms and multiplied by the attempt number) and why (avoid long fixed waits / linear backoff growth)',
        'matches the diff: names src/retry.ts and the fetchWithRetry change without inventing extra files, functions, or behaviour',
        'COMMIT_MSG.md contains the subject and body separated by a blank line',
        'no typos or vague filler (e.g. "fix stuff")',
      ],
      mustFail: [
        'describes a change not present in the diff (wrong file, function, or behaviour)',
        'subject in past tense, non-imperative, or longer than 72 characters',
        'body restates the diff line-by-line without explaining why',
        'wrote nothing to COMMIT_MSG.md, or wrote a message that contradicts the diff',
        'invented a breaking change, issue number, or co-author not in the diff',
      ],
      artifacts: ['COMMIT_MSG.md', 'change.diff'],
    },
  },
  {
    id: 'review-diff',
    title: 'Review a diff and list its concrete risks',
    setup: [
      {
        path: 'change.diff',
        content:
          "diff --git a/src/billing.ts b/src/billing.ts\nindex 0000000..1111111 100644\n--- a/src/billing.ts\n+++ b/src/billing.ts\n@@ -1,12 +1,14 @@\n export function invoice(items: { price: number; qty: number }[], discount: number): number {\n-  const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0)\n-  const total = subtotal - discount\n-  return Math.round(total * 100) / 100\n+  const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0)\n+  const rate = discount / subtotal\n+  const total = subtotal * (1 - rate)\n+  return Math.max(0, Math.round(total * 100) / 100)\n }\n",
      },
    ],
    prompt:
      'Review the diff in `change.diff`. Do not modify any file. In your final answer, list the concrete risks of this change — each as a short bullet naming the risk and why it matters — and note anything that looks like a bug. Be specific to this diff; do not list generic risks.',
    rubric: {
      criteria:
        'Does the review list the specific, concrete risks present in the diff (and any bug), without padding with generic risks?',
      mustPass: [
        'lists at least 3 concrete risks, each tied to a specific line or behaviour in the diff',
        'names the divide-by-zero bug: an empty items array makes subtotal 0, so `discount / subtotal` is NaN/Infinity and total becomes NaN',
        'notes the semantic change: discount switched from a flat amount to a rate, silently changing what callers pass',
        'notes that `Math.max(0, …)` clamps negative totals to 0, hiding a billing bug (free items)',
        'creates no files and modifies nothing',
      ],
      mustFail: [
        'lists generic risks not present in the diff ("needs tests", "check performance") without tying them to this diff',
        'misses the central divide-by-zero bug',
        'invented a risk that contradicts the diff',
        'modified a file or wrote output files',
        'hand-wavy restatement of the diff with no risk analysis',
      ],
      artifacts: ['change.diff'],
    },
  },
]
