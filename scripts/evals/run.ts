#!/usr/bin/env bun
/**
 * P10 eval runner — "did the agent actually do the task?".
 *
 *   bun scripts/evals/run.ts --mock
 *   bun scripts/evals/run.ts --tasks=exact-file,json-shape --runs=3 --json=report.json
 *   MICRO_API_KEY=… bun scripts/evals/run.ts --tasks=fix-failing-test
 *
 * Each task runs in a fresh mkdtemp sandbox (setup applied, harness run, then
 * graded *in that sandbox* by a deterministic predicate). Every attempt is
 * recorded; the exit code is 0 iff every graded attempt passed.
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
import { tasks, type Task } from './tasks.ts'

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

// ------------------------------------------------------------------ runner

interface Attempt {
  run: number
  status: 'pass' | 'fail' | 'error'
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
}

const ANSWER_MAX = 240
const truncate = (s: string, max = ANSWER_MAX): string => (s.length > max ? s.slice(0, max) + '…' : s)

async function runAttempt(task: Task, runIndex: number, systemPrompt: string): Promise<Attempt> {
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

    // grade the sandbox — a thrown check counts as a fail (e.g. a file the agent
    // never created), not as an infrastructure error.
    let ok = false
    let detail: string | undefined
    try {
      ok = await task.check(cwd)
    } catch (err) {
      detail = `check: ${String((err as Error)?.message ?? err)}`
    }

    return {
      run: runIndex,
      status: ok ? 'pass' : 'fail',
      turns: m.turns,
      steps: m.steps,
      toolCalls: m.toolCalls,
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cost: m.cost,
      ms: Date.now() - started,
      answer: truncate(answer),
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

function pad(s: string, w: number, align: 'l' | 'r' = 'l'): string {
  const str = s.length > w ? s.slice(0, w - 1) + '…' : s
  return align === 'r' ? str.padStart(w) : str.padEnd(w)
}

function renderTable(results: TaskResult[], runsPerTask: number): string {
  const rows: string[] = []
  rows.push(
    ['task', 'run', 'status', 'steps', 'tools', 'in', 'out', 'cache', 'cost', 'ms']
      .map((h, i) => pad(h, [14, 4, 6, 5, 5, 6, 6, 6, 10, 7][i]!))
      .join('  '),
  )
  for (const r of results) {
    for (const a of r.attempts) {
      rows.push(
        [
          pad(r.task.id, 14),
          pad(`${a.run}/${runsPerTask}`, 4),
          pad(a.status, 6),
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
  input: number
  output: number
  cacheRead: number
  cost: number
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
    input: attempts.reduce((n, a) => n + a.input, 0),
    output: attempts.reduce((n, a) => n + a.output, 0),
    cacheRead: attempts.reduce((n, a) => n + a.cacheRead, 0),
    cost: attempts.reduce((n, a) => n + a.cost, 0),
    medianMs,
  }
}

function summaryLine(s: Summary, runsPerTask: number): string {
  const rate = s.attempts ? (s.passed / s.attempts) * 100 : 0
  return (
    `summary: ${s.tasks} task(s) × ${runsPerTask} run(s) = ${s.attempts} attempts · ` +
    `${s.passed} pass · ${s.failed} fail · ${s.errors} error · ` +
    `pass rate ${rate.toFixed(1)}% · in ${s.input} tok · out ${s.output} tok · cache ${s.cacheRead} tok · ` +
    `cost $${s.cost.toFixed(6)} · median ${s.medianMs} ms`
  )
}

function jsonReport(results: TaskResult[], s: Summary, runsPerTask: number): unknown {
  return {
    generatedAt: new Date().toISOString(),
    provider: mock ? 'mock' : `openai-compatible (${model})`,
    model,
    runsPerTask,
    summary: {
      tasks: s.tasks,
      attempts: s.attempts,
      passed: s.passed,
      failed: s.failed,
      errors: s.errors,
      passRate: s.attempts ? s.passed / s.attempts : 0,
      input: s.input,
      output: s.output,
      cacheRead: s.cacheRead,
      cost: s.cost,
      medianMs: s.medianMs,
    },
    tasks: results.map((r) => ({
      id: r.task.id,
      title: r.task.title,
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
        ...(a.detail ? { detail: a.detail } : {}),
      })),
    })),
  }
}

function mdReport(results: TaskResult[], s: Summary, runsPerTask: number): string {
  const lines: string[] = []
  lines.push('# micro-harness eval report', '')
  lines.push(`- provider: ${mock ? 'mock (scripted, no network)' : `openai-compatible · ${model}`}`)
  lines.push(`- ${s.tasks} task(s) × ${runsPerTask} run(s) = ${s.attempts} attempts`)
  lines.push(
    `- pass rate: ${s.attempts ? ((s.passed / s.attempts) * 100).toFixed(1) : '0.0'}% (${s.passed} pass / ${s.failed} fail / ${s.errors} error)`,
  )
  lines.push(`- tokens: input ${s.input} · output ${s.output} · cache ${s.cacheRead}`)
  lines.push(`- cost: $${s.cost.toFixed(6)} · median ${s.medianMs} ms`, '')
  lines.push('## Results', '')
  lines.push('| task | run | status | steps | tools | in | out | cache | cost | ms | answer |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    for (const a of r.attempts) {
      const answer = a.answer.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
      lines.push(
        `| ${r.task.id} | ${a.run}/${runsPerTask} | ${a.status} | ${a.steps} | ${a.toolCalls} | ${a.input} | ${a.output} | ${a.cacheRead} | ${a.cost.toFixed(6)} | ${a.ms} | ${answer || (a.detail ?? '—')} |`,
      )
    }
  }
  lines.push('', '_Graded by deterministic predicates over the sandbox — no LLM-as-judge._')
  return lines.join('\n') + '\n'
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const systemPrompt = readFileSync(fileURLToPath(new URL('./prompts/micro-harness.md', import.meta.url)), 'utf8')

  const results: TaskResult[] = []
  for (const task of selected) {
    const attempts: Attempt[] = []
    for (let r = 1; r <= runs; r++) {
      attempts.push(await runAttempt(task, r, systemPrompt))
    }
    results.push({ task, attempts })
  }

  const s = summarize(results)

  if (!quiet) {
    console.log(renderTable(results, runs))
    console.log('')
  }
  console.log(summaryLine(s, runs))

  const jsonPath = opt('json')
  if (jsonPath !== null) {
    const text = JSON.stringify(jsonReport(results, s, runs), null, 2)
    if (jsonPath === '' || jsonPath === '-') console.log(text)
    else writeFileSync(path.resolve(jsonPath), text, 'utf8')
  }

  const mdPath = opt('md')
  if (mdPath !== null) {
    const text = mdReport(results, s, runs)
    if (mdPath === '' || mdPath === '-') console.log(text)
    else writeFileSync(path.resolve(mdPath), text, 'utf8')
  }

  process.exit(s.failed === 0 && s.errors === 0 ? 0 : 1)
}

await main()
