#!/usr/bin/env bun
/**
 * P10 eval runner — "did the agent actually do the task?".
 *
 *   bun scripts/evals/run.ts --mock
 *   bun scripts/evals/run.ts --mock --judge
 *   bun scripts/evals/run.ts --tasks=exact-file,json-shape --runs=3 --json=report.json
 *   MICRO_API_KEY=… bun scripts/evals/run.ts --tasks=fix-failing-test
 *
 * Each task runs in a fresh mkdtemp sandbox (setup applied, harness run, then
 * graded *in that sandbox*). Deterministic tasks are graded by a pure predicate.
 * Judge-graded tasks (a `rubric`, with or without a `check`) are additionally graded
 * by the LLM-as-judge when `--judge` is set — and, for `both` tasks, the judge's
 * verdict is compared against the deterministic check as calibration. Every attempt
 * is recorded; the exit code is 0 iff every graded attempt passed.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Harness } from '../../packages/core/src/harness.ts'
import { openaiProvider } from '../../packages/core/src/provider.ts'
import type { ChatRequest, ChatResponse, Provider } from '../../packages/core/src/provider.ts'
import { EventHub } from '../../packages/core/src/events.ts'
import type { TaggedEvent } from '../../packages/core/src/events.ts'
import { makeTools } from '../../packages/core/src/tools.ts'
import { AgentRunner, createAgentRegistry, makeTaskTool } from '../../packages/core/src/agents.ts'
import { tasks, gradeMode, type Task, type GradeMode } from './tasks.ts'
import { judgeTask, makeScriptedJudge, type JudgeInput, type JudgeVerdict } from './judge.ts'

// ------------------------------------------------------------------ argv

const argv = process.argv.slice(2)

function has(name: string): boolean {
  return argv.includes(`--${name}`)
}

/** Value of `--name=v` or `--name v`; null when absent, '' when flag has no value. */
function opt(name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === `--${name}`) {
      const next = argv[i + 1]
      return next !== undefined && !next.startsWith('--') ? next : ''
    }
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3)
  }
  return null
}

const HELP = `micro-harness evals (P10)

usage: bun scripts/evals/run.ts [flags]

  --mock              use the scripted provider (no network, no API key)
  --task=<id>         run only this task
  --tasks=<a,b,c>     run only these tasks
  --runs=<N>          runs per task (default 2)
  --max-steps=<N>     model loop step budget (default 24)
  --judge             enable LLM-as-judge for judge-graded tasks (default: off —
                      without it, judge-only tasks report \`skipped\`)
  --judge-model=<id>  judge model (default: deepseek-reasoner when the agent model
                      is deepseek-chat, else the agent model)
  --judge-runs=<N>    judge calls per attempt; majority verdict (default 1)
  --json=<path>       write the JSON report (empty/- means stdout)
  --md=<path>         write the Markdown report
  --quiet             no table; summary line only
  --help              show this help

env: MICRO_BASE_URL, MICRO_API_KEY (or OPENAI_API_KEY), MICRO_MODEL (default
deepseek-chat); MICRO_PRICE_INPUT / MICRO_PRICE_OUTPUT / MICRO_PRICE_INPUT_CACHED
drive cost accounting (all default 0).`

if (has('help') || has('-h')) {
  console.log(HELP)
  process.exit(0)
}

const mock = has('mock')
const quiet = has('quiet')
const runs = Number(opt('runs') ?? '2') || 2
const maxSteps = Number(opt('max-steps') ?? '24') || 24
const model = process.env.MICRO_MODEL || process.env.OPENAI_MODEL || 'deepseek-chat'
const baseUrl = process.env.MICRO_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com'
const apiKey = process.env.MICRO_API_KEY || process.env.OPENAI_API_KEY || ''
const pricing = {
  input: Number(process.env.MICRO_PRICE_INPUT || '0') || 0,
  output: Number(process.env.MICRO_PRICE_OUTPUT || '0') || 0,
  inputCached: Number(process.env.MICRO_PRICE_INPUT_CACHED || '0') || 0,
}

// judge configuration
const judgeEnabled = has('judge')
const judgeModelOpt = opt('judge-model')
if (judgeModelOpt === '') {
  console.error('error: --judge-model needs a value (e.g. --judge-model=deepseek-reasoner)')
  process.exit(2)
}
const judgeModel = judgeModelOpt ?? (model === 'deepseek-chat' ? 'deepseek-reasoner' : model)
const judgeRuns = Number(opt('judge-runs') ?? '1') || 1
const judgeProvider: Provider = mock
  ? {
      name: 'mock-judge',
      async chat(): Promise<ChatResponse> {
        throw new Error('judge attempted a network call in mock mode')
      },
    }
  : openaiProvider({ baseUrl, apiKey, temperature: 0 })

const judge: JudgeSettings = {
  enabled: judgeEnabled,
  model: judgeModel,
  runs: Math.max(1, judgeRuns),
  provider: judgeProvider,
  sameModel: judgeModel === model,
}

// task selection
const known = new Map(tasks.map((t) => [t.id, t]))
let selectedIds: string[] | null = null
const one = opt('task')
const list = opt('tasks')
if (one !== null && one !== '') selectedIds = [one]
else if (list !== null && list !== '') selectedIds = list.split(',').map((s) => s.trim()).filter(Boolean)
else if (one === '' || list === '') {
  console.error('error: --task/--tasks needs a value (e.g. --tasks=exact-file,json-shape)')
  process.exit(2)
}

const selected: Task[] = selectedIds
  ? selectedIds.map((id) => {
      const t = known.get(id)
      if (!t) {
        console.error(`error: unknown task "${id}" — known: ${[...known.keys()].join(', ')}`)
        process.exit(2)
      }
      return t
    })
  : tasks

if (!mock && !apiKey) {
  console.error('missing API key: set MICRO_API_KEY (or OPENAI_API_KEY), or run with --mock')
  process.exit(1)
}

// ------------------------------------------------------- scripted mock provider

interface ScriptStep {
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  text?: string
}

/**
 * Hand-written solutions, expressed as tool-call scripts. The harness really
 * dispatches these tool calls against the sandbox, so a passing mock task passed
 * through the real loop — only the model was faked. This is what lets CI exercise
 * the whole harness with no network.
 */
const mockScripts: Record<string, ScriptStep[]> = {
  'exact-file': [
    { toolCalls: [{ name: 'write_file', args: { path: 'hello.txt', content: 'hello, micro-harness\n' } }] },
    { text: 'Created hello.txt with the exact required content.' },
  ],
  'fix-failing-test': [
    { toolCalls: [{ name: 'bash', args: { command: 'bun test' } }] },
    { toolCalls: [{ name: 'read_file', args: { path: 'sum.ts' } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: { path: 'sum.ts', content: 'export function sum(a: number, b: number): number {\n  return a + b\n}\n' },
        },
      ],
    },
    { toolCalls: [{ name: 'bash', args: { command: 'bun test' } }] },
    { text: 'Fixed sum.ts to return a + b; `bun test` now passes.' },
  ],
  'rename-symbol': [
    {
      toolCalls: [
        { name: 'read_file', args: { path: 'lib.ts' } },
        { name: 'read_file', args: { path: 'main.ts' } },
      ],
    },
    {
      toolCalls: [
        { name: 'write_file', args: { path: 'lib.ts', content: 'export function doubled(x: number): number {\n  return x * 2\n}\n' } },
        {
          name: 'write_file',
          args: { path: 'main.ts', content: "import { doubled } from './lib.ts'\n\nconst result = doubled(21)\nconsole.log(result)\n" },
        },
      ],
    },
    { text: 'Renamed oldName to doubled in lib.ts and main.ts.' },
  ],
  'json-shape': [
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'config.json',
            content: '{\n  "name": "micro-harness",\n  "port": 8787,\n  "retries": 3,\n  "enabled": true\n}\n',
          },
        },
      ],
    },
    { text: 'Created config.json with the required shape.' },
  ],
  'flip-flag': [
    { toolCalls: [{ name: 'read_file', args: { path: 'settings.env' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'settings.env', content: 'PORT=8080\nDEBUG=true\nLOG_LEVEL=info\n' } }] },
    { text: 'Set DEBUG=true in settings.env, leaving the rest untouched.' },
  ],
  'read-and-write': [
    { toolCalls: [{ name: 'read_file', args: { path: 'clue.txt' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'result.txt', content: 'serendipity\n' } }] },
    { text: 'Wrote the word from clue.txt into result.txt.' },
  ],
  'append-section': [
    { toolCalls: [{ name: 'read_file', args: { path: 'notes.md' } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'notes.md',
            content: '# Project Notes\n\nSome existing content.\n\n## Changelog\n- 2025-01-01: first release\n',
          },
        },
      ],
    },
    { text: 'Appended the Changelog section to notes.md.' },
  ],
  'hello-run': [
    { toolCalls: [{ name: 'read_file', args: { path: 'hello.ts' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'hello.ts', content: "console.log('Hello, world!')\n" } }] },
    { toolCalls: [{ name: 'bash', args: { command: 'bun run hello.ts' } }] },
    { text: 'Fixed hello.ts; `bun run hello.ts` now prints Hello, world!.' },
  ],
  'surgical-edit': [
    { toolCalls: [{ name: 'read_file', args: { path: 'server.toml' } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'server.toml',
            content: `[server]
host = "0.0.0.0"
port = 8080
workers = 4

[logging]
level = "info"
format = "json"
`,
          },
        },
      ],
    },
    { text: 'Changed only the `workers` value under [server] from 2 to 4 in server.toml.' },
  ],
  'extend-module': [
    { toolCalls: [{ name: 'read_file', args: { path: 'math.ts' } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'math.ts',
            content: `export function double(x: number): number {
  return x * 2
}

export function triple(x: number): number {
  return x * 3
}
`,
          },
        },
      ],
    },
    { text: 'Added and exported triple to math.ts, leaving double exactly as it was.' },
  ],
  'delete-file': [
    { toolCalls: [{ name: 'list_dir', args: {} }] },
    { toolCalls: [{ name: 'bash', args: { command: 'rm stale.txt' } }] },
    { text: 'Deleted stale.txt; keep.txt was left untouched.' },
  ],
  'fix-package-script': [
    { toolCalls: [{ name: 'bash', args: { command: 'bun run start' } }] },
    { toolCalls: [{ name: 'read_file', args: { path: 'package.json' } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'package.json',
            content: `{
  "name": "greeter",
  "version": "1.0.0",
  "scripts": {
    "start": "bun run greet.ts"
  }
}
`,
          },
        },
      ],
    },
    { toolCalls: [{ name: 'bash', args: { command: 'bun run start' } }] },
    { text: 'Fixed the `greet.tss` typo to `greet.ts` in package.json; `bun run start` now prints Hello, config!.' },
  ],
  'refactor-readability': [
    {
      toolCalls: [
        { name: 'read_file', args: { path: 'pricing.ts' } },
        { name: 'read_file', args: { path: 'pricing.test.ts' } },
      ],
    },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'pricing.ts',
            content: `export function total(items: { price: number; qty: number }[], taxRate: number, discount: number): number {
  let subtotal = 0
  for (const item of items) {
    if (item.price > 0 && item.qty > 0) {
      subtotal += item.price * item.qty
    }
  }
  if (subtotal > 100 && discount > 0) {
    subtotal -= subtotal * discount
  }
  if (taxRate > 0) {
    subtotal += subtotal * taxRate
  }
  return Math.round(subtotal * 100) / 100
}
`,
          },
        },
      ],
    },
    { toolCalls: [{ name: 'bash', args: { command: 'bun test' } }] },
    { text: 'Refactored total into a single subtotal accumulator, removing the redundant dead branches; `bun test` passes with pricing.test.ts untouched.' },
  ],
  'explain-a-bug': [
    { toolCalls: [{ name: 'read_file', args: { path: 'max.ts' } }] },
    {
      text: 'The bug is that `max` is initialised to `0` instead of the first element (or `-Infinity`). For an all-negative input like `[-5, -2, -9]`, every comparison `nums[i] > max` is `nums[i] > 0`, which is never true, so `max` is never updated and the function returns the initial `0` — a value that is not in the input array. Fix: start from `nums[0]` and iterate the rest (handling the empty array), or initialise `max` to `-Infinity`.',
    },
  ],
  'design-small-api': [
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'duration.ts',
            content: `export function parseDuration(input: string): number {
  if (input === '') {
    throw new Error('parseDuration: input must not be empty')
  }
  const units: Record<string, number> = { h: 3600, m: 60, s: 1 }
  const pattern = /(\\d+)([hms])/g
  let total = 0
  let matchedUpTo = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input)) !== null) {
    total += Number(match[1]) * units[match[2]]
    matchedUpTo = match.index + match[0].length
  }
  if (matchedUpTo !== input.length) {
    throw new Error('parseDuration: invalid duration ' + JSON.stringify(input) + ' — expected one or more <number><unit> pairs (h, m, or s)')
  }
  return total
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isInteger(totalSeconds) || totalSeconds < 0) {
    throw new Error('formatDuration: totalSeconds must be a non-negative integer, got ' + totalSeconds)
  }
  if (totalSeconds === 0) return '0s'
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(hours + 'h')
  if (minutes > 0) parts.push(minutes + 'm')
  if (seconds > 0) parts.push(seconds + 's')
  return parts.join(' ')
}
`,
          },
        },
      ],
    },
    { text: 'Implemented duration.ts exporting exactly parseDuration and formatDuration, which fail loudly on invalid input.' },
  ],
  'write-documentation': [
    { toolCalls: [{ name: 'read_file', args: { path: 'geo.ts' } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'geo.md',
            content: `# geo

Geometry helpers.

## circleArea(radius: number): number

Returns the area of a circle with the given radius (\`Math.PI * radius * radius\`). Throws an \`Error\` if \`radius\` is negative.

## distance(x1: number, y1: number, x2: number, y2: number): number

Returns the Euclidean distance between \`(x1, y1)\` and \`(x2, y2)\`.

## isValidTriangle(a: number, b: number, c: number): boolean

Returns \`true\` when all three sides are positive and satisfy the triangle inequality (\`a + b > c\`, \`b + c > a\`, \`a + c > b\`).

## Usage

\`\`\`ts
import { circleArea, distance, isValidTriangle } from './geo.ts'

console.log(circleArea(2))          // ~12.57
console.log(distance(0, 0, 3, 4))   // 5
console.log(isValidTriangle(3, 4, 5)) // true
\`\`\`
`,
          },
        },
      ],
    },
    { text: 'Wrote geo.md documenting circleArea, distance, and isValidTriangle, with a runnable usage example; geo.ts is unchanged.' },
  ],
  'add-validation': [
    { toolCalls: [{ name: 'read_file', args: { path: 'config.ts' } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'config.ts',
            content: `export interface Config {
  host: string
  port: number
  debug: boolean
}

export function parseConfig(raw: string): Config {
  const lines = raw.split('\\n').filter((l) => l.trim() !== '')
  const cfg: Record<string, string> = {}
  for (const line of lines) {
    const eq = line.indexOf('=')
    if (eq === -1) {
      throw new Error('parseConfig: invalid line ' + JSON.stringify(line) + ' — expected a "key=value" pair')
    }
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    cfg[key] = value
  }

  if (cfg.host === undefined || cfg.host === '') {
    throw new Error('parseConfig: "host" is required — expected a non-empty host string')
  }

  const port = Number(cfg.port)
  if (cfg.port === undefined || cfg.port === '' || !Number.isInteger(port)) {
    throw new Error('parseConfig: "port" must be an integer — got ' + JSON.stringify(cfg.port ?? null))
  }

  return {
    host: cfg.host,
    port,
    debug: cfg.debug === 'true',
  }
}
`,
          },
        },
      ],
    },
    { text: 'Added validation to parseConfig so bad input throws descriptive errors naming the offending key, while the valid path is unchanged.' },
  ],
  'choose-right-approach': [
    { toolCalls: [{ name: 'read_file', args: { path: 'transform.ts' } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'transform.ts',
            content: `export interface Order {
  id: number
  total: number
  status: 'paid' | 'unpaid' | 'refunded'
}

export function paidTotals(orders: Order[]): number[] {
  return orders.filter((o) => o.status === 'paid').map((o) => o.total)
}

export function topOrders(orders: Order[]): { id: number; total: number }[] {
  return orders
    .slice()
    .sort((a, b) => b.total - a.total)
    .slice(0, 3)
    .map(({ id, total }) => ({ id, total }))
}
`,
          },
        },
      ],
    },
    { toolCalls: [{ name: 'bash', args: { command: 'bun test' } }] },
    { text: 'Rewrote paidTotals with filter/map and topOrders with a slice/sort/slice/map pipeline. Idiomatic array methods keep the behaviour identical without adding abstractions or dependencies.' },
  ],
  'extract-constant': [
    { toolCalls: [{ name: 'read_file', args: { path: 'physics.ts' } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'physics.ts',
            content:
              'export const GRAVITY = 9.80665\n\nexport function fallTime(height: number): number {\n  return Math.sqrt((2 * height) / GRAVITY)\n}\n\nexport function impactSpeed(height: number): number {\n  return Math.sqrt(2 * GRAVITY * height)\n}\n',
          },
        },
      ],
    },
    { text: 'Extracted 9.80665 into an exported GRAVITY constant and replaced both uses with it.' },
  ],
  'fix-off-by-one': [
    { toolCalls: [{ name: 'bash', args: { command: 'bun test' } }] },
    { toolCalls: [{ name: 'read_file', args: { path: 'range.ts' } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'range.ts',
            content:
              'export function range(n: number): number[] {\n  const out: number[] = []\n  for (let i = 0; i < n; i++) {\n    out.push(i)\n  }\n  return out\n}\n',
          },
        },
      ],
    },
    { toolCalls: [{ name: 'bash', args: { command: 'bun test' } }] },
    { text: 'Changed the loop bound from `i <= n` to `i < n`; `bun test` now passes. range.test.ts was left untouched.' },
  ],
  'add-test-case': [
    { toolCalls: [{ name: 'read_file', args: { path: 'parity.ts' } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'parity.test.ts',
            content:
              "import { expect, test } from 'bun:test'\nimport { isEven } from './parity.ts'\n\ntest('isEven', () => {\n  expect(isEven(4)).toBe(true)\n  expect(isEven(7)).toBe(false)\n  expect(isEven(0)).toBe(true)\n})\n",
          },
        },
      ],
    },
    { toolCalls: [{ name: 'bash', args: { command: 'bun test' } }] },
    { text: 'Added parity.test.ts covering isEven(4), isEven(7) and isEven(0); `bun test` passes.' },
  ],
  'idempotent-script': [
    { toolCalls: [{ name: 'read_file', args: { path: 'log.ts' } }] },
    {
      toolCalls: [
        {
          name: 'write_file',
          args: {
            path: 'log.ts',
            content:
              "import { existsSync, readFileSync, appendFileSync } from 'node:fs'\n\nconst current = existsSync('log.txt') ? readFileSync('log.txt', 'utf8') : ''\nif (!current.split('\\n').includes('marker=present')) {\n  appendFileSync('log.txt', 'marker=present\\n')\n}\n",
          },
        },
      ],
    },
    { toolCalls: [{ name: 'bash', args: { command: 'bun log.ts' } }] },
    { toolCalls: [{ name: 'bash', args: { command: 'bun log.ts' } }] },
    { toolCalls: [{ name: 'read_file', args: { path: 'log.txt' } }] },
    { text: 'Made log.ts append the marker only when it is absent; running it twice leaves log.txt unchanged.' },
  ],
}

function mockProvider(taskId: string): Provider {
  const script = mockScripts[taskId] ?? [{ text: 'done' }]
  let i = 0
  return {
    name: 'mock',
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      const step = script[Math.min(i, script.length - 1)]!
      i++
      const usage = {
        prompt_tokens: 40,
        completion_tokens: 8,
        ...(i > 1 ? { prompt_cache_hit_tokens: 24 } : {}),
      }
      if (step.toolCalls) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: step.toolCalls.map((c, n) => ({
              id: `call_${i}_${n}`,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          },
          usage,
        }
      }
      return { message: { role: 'assistant', content: step.text ?? 'done' }, usage }
    },
  }
}

// ------------------------------------------------------------------ judge glue

interface JudgeSettings {
  enabled: boolean
  model: string
  runs: number
  provider: Provider
  /** True when the judge model is the same model that produced the work. */
  sameModel: boolean
}

interface JudgeOutcome {
  verdict: 'pass' | 'fail' | 'error'
  score?: number
  runs: number
  input: number
  output: number
  cacheRead: number
  cost: number
  ms: number
  reasons: string[]
  violations: string[]
  detail?: string
}

function collectArtifacts(cwd: string, artifacts: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rel of artifacts) {
    try {
      out[rel] = readFileSync(path.join(cwd, rel), 'utf8')
    } catch {
      out[rel] = '(missing)'
    }
  }
  return out
}

/**
 * The offline verdict for `--mock`: base it on the deterministic check when one
 * exists (pass → pass, fail → fail), else pass. `fix-failing-test` fails only when
 * its sandbox check failed, so the fail branch is reachable.
 */
function scriptedVerdictFor(task: Task, checkOk: boolean | undefined): JudgeVerdict {
  if (task.id === 'fix-failing-test' && checkOk === false) {
    return {
      verdict: 'fail',
      score: 0,
      reasons: ['The scripted judge sees the sandbox still fails `bun test`.'],
      violations: ['`bun test` does not pass'],
    }
  }
  if (checkOk !== undefined) {
    return checkOk
      ? {
          verdict: 'pass',
          score: 5,
          reasons: ['The deterministic check passes; the scripted judge agrees the task was completed as specified.'],
          violations: [],
        }
      : {
          verdict: 'fail',
          score: 0,
          reasons: ['The deterministic check failed.'],
          violations: ['deterministic check failed'],
        }
  }
  return {
    verdict: 'pass',
    score: 5,
    reasons: ['The scripted judge finds the final answer and artifacts plausibly satisfy the rubric.'],
    violations: [],
  }
}

async function runJudge(
  input: JudgeInput,
  judge: JudgeSettings,
  scripted: ((input: JudgeInput) => Promise<JudgeVerdict>) | null,
): Promise<JudgeOutcome> {
  const started = Date.now()
  const runs = Math.max(1, judge.runs)
  const verdicts: JudgeVerdict[] = []
  let inputTok = 0
  let outputTok = 0
  let cacheTok = 0
  let cost = 0
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('judge timed out')), 180_000)
  try {
    for (let i = 0; i < runs; i++) {
      if (scripted) {
        verdicts.push(await scripted(input))
      } else {
        const r = await judgeTask({ ...input, provider: judge.provider, model: judge.model, pricing, signal: controller.signal })
        verdicts.push(r)
        inputTok += r.input
        outputTok += r.output
        cacheTok += r.cacheRead
        cost += r.cost ?? 0
      }
    }
  } catch (err) {
    return {
      verdict: 'error',
      runs,
      input: inputTok,
      output: outputTok,
      cacheRead: cacheTok,
      cost,
      ms: Date.now() - started,
      reasons: [],
      violations: [],
      detail: String((err as Error)?.message ?? err),
    }
  } finally {
    clearTimeout(timer)
  }

  const passes = verdicts.filter((v) => v.verdict === 'pass').length
  const verdict: 'pass' | 'fail' = passes > verdicts.length - passes ? 'pass' : 'fail'
  const score = verdicts.length ? verdicts.reduce((n, v) => n + v.score, 0) / verdicts.length : 0
  return {
    verdict,
    score,
    runs,
    input: inputTok,
    output: outputTok,
    cacheRead: cacheTok,
    cost,
    ms: Date.now() - started,
    reasons: [...new Set(verdicts.flatMap((v) => v.reasons))],
    violations: [...new Set(verdicts.flatMap((v) => v.violations))],
  }
}

function finalStatus(
  mode: GradeMode,
  checkOk: boolean | undefined,
  judgeEnabled: boolean,
  judgeOutcome: JudgeOutcome | undefined,
): Attempt['status'] {
  if (mode === 'deterministic') return checkOk ? 'pass' : 'fail'
  if (mode === 'judge') {
    if (!judgeEnabled) return 'skipped'
    if (!judgeOutcome || judgeOutcome.verdict === 'error') return 'error'
    return judgeOutcome.verdict === 'pass' ? 'pass' : 'fail'
  }
  // mode === 'both'
  if (!judgeEnabled) return checkOk ? 'pass' : 'fail'
  if (checkOk === false) return 'fail' // deterministic gate is authoritative; the judge cannot rescue it
  if (!judgeOutcome || judgeOutcome.verdict === 'error') return 'error' // judge required to confirm a pass
  return judgeOutcome.verdict === 'pass' ? 'pass' : 'fail'
}

// ------------------------------------------------------------------ runner

interface Attempt {
  run: number
  status: 'pass' | 'fail' | 'error' | 'skipped'
  turns: number
  steps: number
  toolCalls: number
  input: number
  output: number
  cacheRead: number
  cost: number
  ms: number
  answer: string
  detail?: string
  checkOk?: boolean
  checkDetail?: string
  judge?: JudgeOutcome
}

const ANSWER_MAX = 240
const truncate = (s: string, max = ANSWER_MAX): string => (s.length > max ? s.slice(0, max) + '…' : s)

async function runAttempt(task: Task, runIndex: number, systemPrompt: string, judge: JudgeSettings): Promise<Attempt> {
  const started = Date.now()
  const cwd = mkdtempSync(path.join(tmpdir(), 'mh-eval-'))
  const m = { turns: 0, steps: 0, toolCalls: 0, input: 0, output: 0, cacheRead: 0, cost: 0 }

  const hub = new EventHub()
  hub.on((e: TaggedEvent) => {
    switch (e.event.type) {
      case 'user.message':
        m.turns++
        break
      case 'turn.start':
        m.steps++
        break
      case 'tool.call':
        m.toolCalls++
        break
      case 'usage':
        m.input += e.event.input
        m.output += e.event.output
        m.cacheRead += e.event.cacheRead ?? 0
        m.cost += e.event.cost ?? 0
        break
    }
  })

  try {
    for (const f of task.setup ?? []) {
      const target = path.join(cwd, f.path)
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, f.content, 'utf8')
    }

    const provider = mock ? mockProvider(task.id) : openaiProvider({ baseUrl, apiKey })
    const tools = makeTools()
    const runner = new AgentRunner({
      provider,
      model,
      cwd,
      hub,
      roles: createAgentRegistry([]),
      tools,
      allowBash: true,
      pricing,
    })
    const harness = new Harness({
      provider,
      model,
      cwd,
      allowBash: true,
      maxSteps,
      systemPrompt,
      hub,
      pricing,
      approval: 'full-auto',
      tools: [...tools, makeTaskTool(runner)],
    })

    const timeoutMs = task.timeoutMs ?? 300_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
    let answer = ''
    try {
      answer = await harness.send(task.prompt, controller.signal)
    } finally {
      clearTimeout(timer)
    }

    const mode = gradeMode(task)

    // Deterministic check — a thrown check counts as a fail (e.g. a file the agent
    // never created), not as an infrastructure error.
    let checkOk: boolean | undefined
    let checkDetail: string | undefined
    if (task.check) {
      try {
        checkOk = await task.check(cwd)
      } catch (err) {
        checkOk = false
        checkDetail = `check: ${String((err as Error)?.message ?? err)}`
      }
    }

    // LLM judge, when enabled and the task needs one.
    let judgeOutcome: JudgeOutcome | undefined
    if (judge.enabled && (mode === 'judge' || mode === 'both')) {
      const judgeInput: JudgeInput = {
        task,
        answer,
        artifacts: collectArtifacts(cwd, task.rubric?.artifacts ?? []),
      }
      const scripted = mock ? makeScriptedJudge(scriptedVerdictFor(task, checkOk)) : null
      judgeOutcome = await runJudge(judgeInput, judge, scripted)
    }

    const status = finalStatus(mode, checkOk, judge.enabled, judgeOutcome)

    let detail: string | undefined = checkDetail
    if (judgeOutcome?.verdict === 'error' && judgeOutcome.detail) {
      detail = detail ? `${detail}; judge: ${judgeOutcome.detail}` : `judge: ${judgeOutcome.detail}`
    }
    if (status === 'skipped') detail = 'judge not enabled (pass --judge)'

    return {
      run: runIndex,
      status,
      turns: m.turns,
      steps: m.steps,
      toolCalls: m.toolCalls,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cost: m.cost,
      ms: Date.now() - started,
      answer: truncate(answer),
      ...(checkOk !== undefined ? { checkOk, ...(checkDetail ? { checkDetail } : {}) } : {}),
      ...(judgeOutcome ? { judge: judgeOutcome } : {}),
      ...(detail ? { detail } : {}),
    }
  } catch (err) {
    return {
      run: runIndex,
      status: 'error',
      turns: m.turns,
      steps: m.steps,
      toolCalls: m.toolCalls,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cost: m.cost,
      ms: Date.now() - started,
      answer: '',
      detail: String((err as Error)?.message ?? err),
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------------ report

interface TaskResult {
  task: Task
  attempts: Attempt[]
}

interface CalibrationRow {
  taskId: string
  check: 'pass' | 'fail'
  judge: 'pass' | 'fail' | 'error'
  score?: number
}

function collectCalibration(results: TaskResult[]): CalibrationRow[] {
  const rows: CalibrationRow[] = []
  for (const r of results) {
    if (gradeMode(r.task) !== 'both') continue
    for (const a of r.attempts) {
      if (!a.judge || a.checkOk === undefined) continue
      rows.push({
        taskId: r.task.id,
        check: a.checkOk ? 'pass' : 'fail',
        judge: a.judge.verdict,
        ...(a.judge.score !== undefined ? { score: a.judge.score } : {}),
      })
    }
  }
  return rows
}

function pad(s: string, w: number, align: 'l' | 'r' = 'l'): string {
  const str = s.length > w ? s.slice(0, w - 1) + '…' : s
  return align === 'r' ? str.padStart(w) : str.padEnd(w)
}

function renderTable(results: TaskResult[], runsPerTask: number): string {
  const headers = ['task', 'run', 'status', 'judge', 'score', 'steps', 'tools', 'in', 'out', 'cache', 'cost', 'ms']
  const widths = [14, 4, 7, 5, 5, 5, 5, 6, 6, 6, 10, 7]
  const rows: string[] = []
  rows.push(headers.map((h, i) => pad(h, widths[i]!)).join('  '))
  for (const r of results) {
    for (const a of r.attempts) {
      const judgeVal = a.judge ? a.judge.verdict : '—'
      const scoreVal = a.judge?.score !== undefined ? a.judge.score.toFixed(1) : '—'
      rows.push(
        [
          pad(r.task.id, 14),
          pad(`${a.run}/${runsPerTask}`, 4),
          pad(a.status, 7),
          pad(judgeVal, 5),
          pad(scoreVal, 5, 'r'),
          pad(String(a.steps), 5, 'r'),
          pad(String(a.toolCalls), 5, 'r'),
          pad(String(a.input), 6, 'r'),
          pad(String(a.output), 6, 'r'),
          pad(String(a.cacheRead), 6, 'r'),
          pad(a.cost.toFixed(6), 10, 'r'),
          pad(String(a.ms), 7, 'r'),
        ].join('  '),
      )
    }
  }
  return rows.join('\n')
}

interface Summary {
  tasks: number
  attempts: number
  passed: number
  failed: number
  errors: number
  skipped: number
  input: number
  output: number
  cacheRead: number
  cost: number
  judgeCost: number
  judgeInput: number
  judgeOutput: number
  medianMs: number
}

function summarize(results: TaskResult[]): Summary {
  const attempts = results.flatMap((r) => r.attempts)
  const sorted = attempts.map((a) => a.ms).sort((x, y) => x - y)
  const mid = Math.floor(sorted.length / 2)
  const medianMs = sorted.length
    ? sorted.length % 2
      ? sorted[mid]!
      : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
    : 0
  return {
    tasks: results.length,
    attempts: attempts.length,
    passed: attempts.filter((a) => a.status === 'pass').length,
    failed: attempts.filter((a) => a.status === 'fail').length,
    errors: attempts.filter((a) => a.status === 'error').length,
    skipped: attempts.filter((a) => a.status === 'skipped').length,
    input: attempts.reduce((n, a) => n + a.input, 0),
    output: attempts.reduce((n, a) => n + a.output, 0),
    cacheRead: attempts.reduce((n, a) => n + a.cacheRead, 0),
    cost: attempts.reduce((n, a) => n + a.cost, 0),
    judgeCost: attempts.reduce((n, a) => n + (a.judge?.cost ?? 0), 0),
    judgeInput: attempts.reduce((n, a) => n + (a.judge?.input ?? 0), 0),
    judgeOutput: attempts.reduce((n, a) => n + (a.judge?.output ?? 0), 0),
    medianMs,
  }
}

function summaryLine(s: Summary, runsPerTask: number, judge: JudgeSettings): string {
  const graded = s.attempts - s.skipped
  const rate = graded ? (s.passed / graded) * 100 : 0
  const segs: string[] = []
  segs.push(`summary: ${s.tasks} task(s) × ${runsPerTask} run(s) = ${s.attempts} attempts`)
  segs.push(`${s.passed} pass`, `${s.failed} fail`, `${s.errors} error`)
  if (s.skipped) segs.push(`${s.skipped} skipped`)
  segs.push(`pass rate ${rate.toFixed(1)}%`)
  segs.push(`in ${s.input} tok`, `out ${s.output} tok`, `cache ${s.cacheRead} tok`)
  segs.push(`cost $${s.cost.toFixed(6)}`)
  if (judge.enabled) {
    segs.push(`judge ${judge.model}`)
    segs.push(`judge cost $${s.judgeCost.toFixed(6)}`)
  }
  segs.push(`median ${s.medianMs} ms`)
  if (judge.enabled && judge.sameModel) segs.push('judge model == agent model (self-preference bias uncontrolled)')
  return segs.join(' · ')
}

function jsonReport(
  results: TaskResult[],
  s: Summary,
  runsPerTask: number,
  judge: JudgeSettings,
  calib: CalibrationRow[],
): unknown {
  const comparable = calib.filter((c) => c.judge !== 'error')
  const agreed = comparable.filter((c) => c.check === c.judge).length
  return {
    generatedAt: new Date().toISOString(),
    provider: mock ? 'mock' : `openai-compatible (${model})`,
    model,
    runsPerTask,
    judge: judge.enabled
      ? { enabled: true, model: judge.model, runs: judge.runs, sameModel: judge.sameModel }
      : { enabled: false },
    summary: {
      tasks: s.tasks,
      attempts: s.attempts,
      passed: s.passed,
      failed: s.failed,
      errors: s.errors,
      skipped: s.skipped,
      passRate: s.attempts - s.skipped ? s.passed / (s.attempts - s.skipped) : 0,
      input: s.input,
      output: s.output,
      cacheRead: s.cacheRead,
      cost: s.cost,
      judgeCost: s.judgeCost,
      judgeInput: s.judgeInput,
      judgeOutput: s.judgeOutput,
      medianMs: s.medianMs,
    },
    calibration: {
      compared: comparable.length,
      agreed,
      rate: comparable.length ? agreed / comparable.length : null,
      disagreements: comparable
        .filter((c) => c.check !== c.judge)
        .map((c) => ({ taskId: c.taskId, check: c.check, judge: c.judge, score: c.score })),
    },
    tasks: results.map((r) => ({
      id: r.task.id,
      title: r.task.title,
      mode: gradeMode(r.task),
      attempts: r.attempts.map((a) => ({
        run: a.run,
        status: a.status,
        turns: a.turns,
        steps: a.steps,
        toolCalls: a.toolCalls,
        input: a.input,
        output: a.output,
        cacheRead: a.cacheRead,
        cost: a.cost,
        ms: a.ms,
        answer: a.answer,
        ...(a.checkOk !== undefined ? { checkOk: a.checkOk } : {}),
        ...(a.checkDetail ? { checkDetail: a.checkDetail } : {}),
        judge: a.judge
          ? {
              verdict: a.judge.verdict,
              score: a.judge.score,
              runs: a.judge.runs,
              reasons: a.judge.reasons,
              violations: a.judge.violations,
              input: a.judge.input,
              output: a.judge.output,
              cacheRead: a.judge.cacheRead,
              cost: a.judge.cost,
              ms: a.judge.ms,
              ...(a.judge.detail ? { detail: a.judge.detail } : {}),
            }
          : null,
        ...(a.detail ? { detail: a.detail } : {}),
      })),
    })),
  }
}

function mdReport(
  results: TaskResult[],
  s: Summary,
  runsPerTask: number,
  judge: JudgeSettings,
  calib: CalibrationRow[],
): string {
  const lines: string[] = []
  lines.push('# micro-harness eval report', '')
  lines.push(`- provider: ${mock ? 'mock (scripted, no network)' : `openai-compatible · ${model}`}`)
  lines.push(
    `- judge: ${judge.enabled ? `${judge.model} × ${judge.runs} run(s)${judge.sameModel ? ' — same model as the agent (self-preference bias uncontrolled)' : ''}` : 'disabled'}`,
  )
  lines.push(`- ${s.tasks} task(s) × ${runsPerTask} run(s) = ${s.attempts} attempts`)
  const graded = s.attempts - s.skipped
  lines.push(
    `- pass rate: ${graded ? ((s.passed / graded) * 100).toFixed(1) : '0.0'}% (${s.passed} pass / ${s.failed} fail / ${s.errors} error${s.skipped ? ` / ${s.skipped} skipped` : ''})`,
  )
  lines.push(`- tokens: input ${s.input} · output ${s.output} · cache ${s.cacheRead}`)
  lines.push(
    `- cost: $${s.cost.toFixed(6)}${judge.enabled ? ` · judge $${s.judgeCost.toFixed(6)} (${s.judgeInput}/${s.judgeOutput} tok)` : ''} · median ${s.medianMs} ms`,
    '',
  )

  if (judge.enabled) {
    const comparable = calib.filter((c) => c.judge !== 'error')
    const agreed = comparable.filter((c) => c.check === c.judge).length
    lines.push('## Calibration (judge vs deterministic check)', '')
    if (comparable.length) {
      lines.push(`- judge agreed ${agreed}/${comparable.length} (${((agreed / comparable.length) * 100).toFixed(1)}%)`)
      const disagreements = comparable.filter((c) => c.check !== c.judge)
      if (disagreements.length) {
        lines.push('- disagreements:')
        for (const d of disagreements) {
          lines.push(`  - \`${d.taskId}\`: check=${d.check} judge=${d.judge}${d.score !== undefined ? ` (score ${d.score.toFixed(1)})` : ''}`)
        }
      }
    } else {
      lines.push('- judge agreed 0/0 — no both-mode tasks to compare')
    }
    lines.push('')
  }

  lines.push('## Results', '')
  lines.push('| task | run | status | judge | score | steps | tools | in | out | cache | cost | ms | answer |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    for (const a of r.attempts) {
      const answer = a.answer.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
      const judgeVal = a.judge ? a.judge.verdict : '—'
      const scoreVal = a.judge?.score !== undefined ? a.judge.score.toFixed(1) : '—'
      lines.push(
        `| ${r.task.id} | ${a.run}/${runsPerTask} | ${a.status} | ${judgeVal} | ${scoreVal} | ${a.steps} | ${a.toolCalls} | ${a.input} | ${a.output} | ${a.cacheRead} | ${a.cost.toFixed(6)} | ${a.ms} | ${answer || (a.detail ?? '—')} |`,
      )
    }
  }
  lines.push(
    '',
    '_Deterministic predicates grade the sandbox; the LLM judge (when enabled) grades open-ended work against the rubric._',
  )
  return lines.join('\n') + '\n'
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const systemPrompt = readFileSync(fileURLToPath(new URL('./prompts/micro-harness.md', import.meta.url)), 'utf8')

  const results: TaskResult[] = []
  for (const task of selected) {
    const attempts: Attempt[] = []
    for (let r = 1; r <= runs; r++) {
      attempts.push(await runAttempt(task, r, systemPrompt, judge))
    }
    results.push({ task, attempts })
  }

  const s = summarize(results)
  const calib = collectCalibration(results)

  if (!quiet) {
    console.log(renderTable(results, runs))
    console.log('')
  }
  console.log(summaryLine(s, runs, judge))
  if (judge.enabled) {
    const comparable = calib.filter((c) => c.judge !== 'error')
    const agreed = comparable.filter((c) => c.check === c.judge).length
    if (comparable.length) {
      console.log(`calibration: judge agreed ${agreed}/${comparable.length} (${((agreed / comparable.length) * 100).toFixed(1)}%)`)
      for (const d of comparable.filter((c) => c.check !== c.judge)) {
        console.log(`  - ${d.taskId}: check=${d.check} judge=${d.judge}${d.score !== undefined ? ` (score ${d.score.toFixed(1)})` : ''}`)
      }
    } else {
      console.log('calibration: judge agreed 0/0 — no both-mode tasks to compare')
    }
  }

  const jsonPath = opt('json')
  if (jsonPath !== null) {
    const text = JSON.stringify(jsonReport(results, s, runs, judge, calib), null, 2)
    if (jsonPath === '' || jsonPath === '-') console.log(text)
    else writeFileSync(path.resolve(jsonPath), text, 'utf8')
  }

  const mdPath = opt('md')
  if (mdPath !== null) {
    const text = mdReport(results, s, runs, judge, calib)
    if (mdPath === '' || mdPath === '-') console.log(text)
    else writeFileSync(path.resolve(mdPath), text, 'utf8')
  }

  process.exit(s.failed === 0 && s.errors === 0 ? 0 : 1)
}

await main()
