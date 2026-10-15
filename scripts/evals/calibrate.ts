#!/usr/bin/env bun
/**
 * P10 judge calibration — measure the LLM judge against the labelled golden set.
 *
 *   bun scripts/evals/calibrate.ts --mock
 *   bun scripts/evals/calibrate.ts --mock --runs=3 --json=calib.json
 *   MICRO_API_KEY=… bun scripts/evals/calibrate.ts --judge-model=deepseek-reasoner
 *
 * For every golden case this rebuilds the exact judge input the runner builds
 * (task prompt + rubric + final answer + artifact contents), asks the judge, and
 * compares the verdict with the maintainer-written label. The reported "accuracy"
 * is agreement with our own documented standard — see golden.ts and the README.
 *
 * `--mock` uses the scripted judge from `judge.ts`, whose verdict is constructed
 * from the case's `label`, so the prompt-build + strict-parse + comparison plumbing
 * is exercised deterministically with no network. A mock accuracy of 100% proves
 * the plumbing works — it says nothing about real judge quality.
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { openaiProvider } from '../../packages/core/src/provider.ts'
import type { Provider } from '../../packages/core/src/provider.ts'
import { judgeTask, makeScriptedJudge } from './judge.ts'
import type { JudgeInput, JudgeVerdict } from './judge.ts'
import { tasks } from './tasks.ts'
import { goldenCases, type GoldenCase } from './golden.ts'

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

const HELP = `micro-harness judge calibration (P10)

usage: bun scripts/evals/calibrate.ts [flags]

  --mock                use the scripted judge (no network); its verdict is
                        constructed from each case's label, so this exercises the
                        plumbing and the exit code, not real judge accuracy
  --runs=N              ask the judge N times per case (self-consistency; default 1)
  --judge-model=<id>    judge model (default: MICRO_JUDGE_MODEL or deepseek-reasoner)
  --min-accuracy=<0..1> accuracy threshold for the exit code (default 0.8)
  --json=<path>         write the JSON report (empty/- means stdout)
  --help                show this help

env: MICRO_BASE_URL, MICRO_API_KEY (or OPENAI_API_KEY). Cost accounting uses
MICRO_PRICE_INPUT / MICRO_PRICE_OUTPUT / MICRO_PRICE_INPUT_CACHED (all default 0).`

if (has('help') || has('-h')) {
  console.log(HELP)
  process.exit(0)
}

const mock = has('mock')
const runs = Math.max(1, Number(opt('runs') ?? '1') || 1)

const judgeModelOpt = opt('judge-model')
if (judgeModelOpt === '') {
  console.error('error: --judge-model needs a value (e.g. --judge-model=deepseek-reasoner)')
  process.exit(2)
}
const judgeModel = judgeModelOpt ?? process.env.MICRO_JUDGE_MODEL ?? 'deepseek-reasoner'

const minRaw = opt('min-accuracy') ?? '0.8'
const minAccuracy = Number(minRaw)
if (!Number.isFinite(minAccuracy) || minAccuracy < 0 || minAccuracy > 1) {
  console.error(`error: --min-accuracy must be a number in [0,1], got "${minRaw}"`)
  process.exit(2)
}

const baseUrl = process.env.MICRO_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com'
const apiKey = process.env.MICRO_API_KEY || process.env.OPENAI_API_KEY || ''
const pricing = {
  input: Number(process.env.MICRO_PRICE_INPUT || '0') || 0,
  output: Number(process.env.MICRO_PRICE_OUTPUT || '0') || 0,
  inputCached: Number(process.env.MICRO_PRICE_INPUT_CACHED || '0') || 0,
}

if (!mock && !apiKey) {
  console.error('missing API key: set MICRO_API_KEY (or OPENAI_API_KEY), or run with --mock')
  process.exit(1)
}

if (goldenCases.length === 0) {
  console.error('error: golden set is empty')
  process.exit(2)
}

const byId = new Map(tasks.map((t) => [t.id, t]))
for (const c of goldenCases) {
  if (!byId.has(c.taskId)) {
    console.error(
      `error: golden case "${c.id}" references unknown task "${c.taskId}" — known: ${[...byId.keys()].join(', ')}`,
    )
    process.exit(2)
  }
}

const provider: Provider = mock
  ? {
      name: 'mock-judge',
      async chat(): Promise<never> {
        throw new Error('judge attempted a network call in mock mode')
      },
    }
  : openaiProvider({ baseUrl, apiKey, temperature: 0 })

/** The mock judge's verdict is derived from the label, so the run is deterministic. */
function verdictFromLabel(label: 'pass' | 'fail'): JudgeVerdict {
  return label === 'pass'
    ? {
        verdict: 'pass',
        score: 5,
        reasons: ['The scripted (label-derived) judge sees the work as meeting every rubric requirement.'],
        violations: [],
      }
    : {
        verdict: 'fail',
        score: 0,
        reasons: [],
        violations: ['The scripted (label-derived) judge sees the work as failing the rubric.'],
      }
}

// ------------------------------------------------------------------ run

interface CaseResult {
  id: string
  taskId: string
  label: 'pass' | 'fail'
  judge: 'pass' | 'fail' | 'error'
  score: number
  runs: number
  verdicts: JudgeVerdict[]
  errors: string[]
  match: boolean
  selfConsistency: number
}

async function judgeCase(c: GoldenCase): Promise<CaseResult> {
  const task = byId.get(c.taskId)!
  const input: JudgeInput = { task, answer: c.answer, artifacts: c.artifacts ?? {} }
  const verdicts: JudgeVerdict[] = []
  const errors: string[] = []

  for (let i = 0; i < runs; i++) {
    if (mock) {
      const scripted = makeScriptedJudge(verdictFromLabel(c.label))
      try {
        verdicts.push(await scripted(input))
      } catch (err) {
        errors.push(String((err as Error)?.message ?? err))
      }
    } else {
      try {
        verdicts.push(await judgeTask({ ...input, provider, model: judgeModel, pricing }))
      } catch (err) {
        errors.push(String((err as Error)?.message ?? err))
      }
    }
  }

  const passes = verdicts.filter((v) => v.verdict === 'pass').length
  const fails = verdicts.filter((v) => v.verdict === 'fail').length
  const judge: 'pass' | 'fail' | 'error' = verdicts.length === 0 ? 'error' : passes > fails ? 'pass' : 'fail'
  const score = verdicts.length ? verdicts.reduce((n, v) => n + v.score, 0) / verdicts.length : 0
  // Self-consistency: share of runs that returned the majority verdict. A judge
  // error is not a vote for the majority, so it counts as disagreement.
  const selfConsistency = runs ? Math.max(passes, fails) / runs : 0

  return {
    id: c.id,
    taskId: c.taskId,
    label: c.label,
    judge,
    score,
    runs,
    verdicts,
    errors,
    match: judge !== 'error' && judge === c.label,
    selfConsistency,
  }
}

function pad(s: string, w: number, align: 'l' | 'r' = 'l'): string {
  const str = s.length > w ? s.slice(0, w - 1) + '…' : s
  return align === 'r' ? str.padStart(w) : str.padEnd(w)
}

function renderTable(results: CaseResult[]): string {
  const cols = ['case', 'taskId', 'label', 'judge', 'score', 'match']
  const widths = [28, 24, 5, 5, 5, 5]
  const rows: string[] = [cols.map((h, i) => pad(h, widths[i]!)).join('  ')]
  for (const r of results) {
    rows.push(
      [
        pad(r.id, 28),
        pad(r.taskId, 24),
        pad(r.label, 5),
        pad(r.judge, 5),
        pad(r.score.toFixed(1), 5, 'r'),
        pad(r.match ? '✓' : '✗', 5),
      ].join('  '),
    )
  }
  return rows.join('\n')
}

function uniqueStrings(verdicts: JudgeVerdict[], key: 'reasons' | 'violations'): string[] {
  return [...new Set(verdicts.flatMap((v) => v[key]))]
}

async function main(): Promise<void> {
  const results: CaseResult[] = []
  for (const c of goldenCases) {
    results.push(await judgeCase(c))
  }

  const total = results.length
  const matched = results.filter((r) => r.match).length
  const accuracy = total ? matched / total : 0
  const falseNegatives = results.filter((r) => r.label === 'pass' && r.judge === 'fail').length
  const falsePositives = results.filter((r) => r.label === 'fail' && r.judge === 'pass').length
  const judgeErrors = results.filter((r) => r.judge === 'error').length
  const runErrors = results.reduce((n, r) => n + r.errors.length, 0)
  const selfConsistency = total ? results.reduce((n, r) => n + r.selfConsistency, 0) / total : 0

  console.log(`judge calibration · ${mock ? 'mock (scripted, label-derived)' : `model ${judgeModel}`} · ${total} case(s) × ${runs} run(s)`)
  console.log('')
  console.log(renderTable(results))
  console.log('')

  console.log(`accuracy: ${matched}/${total} (${(accuracy * 100).toFixed(1)}%) · threshold ${(minAccuracy * 100).toFixed(1)}% (--min-accuracy=${minAccuracy})`)
  console.log(`false-negatives (label=pass, judge=fail): ${falseNegatives}`)
  console.log(`false-positives (label=fail, judge=pass): ${falsePositives}`)
  console.log(`judge errors: ${judgeErrors} case(s), ${runErrors} run(s)`)
  if (runs > 1) {
    console.log(`self-consistency: ${(selfConsistency * 100).toFixed(1)}% (share of runs agreeing with the majority verdict)`)
  }

  const misses = results.filter((r) => !r.match)
  if (misses.length) {
    console.log('')
    console.log(`misses (${misses.length}) — each is either a judge bug or a bad label; read the rationale:`.toUpperCase())
    for (const r of misses) {
      const c = goldenCases.find((g) => g.id === r.id)!
      console.log('')
      console.log(`  ${r.id} (${r.taskId})  label=${r.label}  judge=${r.judge}  score=${r.score.toFixed(1)}`)
      console.log(`    rationale: ${c.rationale}`)
      const reasons = uniqueStrings(r.verdicts, 'reasons')
      const violations = uniqueStrings(r.verdicts, 'violations')
      if (reasons.length) console.log(`    judge reasons: ${reasons.join(' | ')}`)
      if (violations.length) console.log(`    judge violations: ${violations.join(' | ')}`)
      for (const e of r.errors) console.log(`    judge error: ${e}`)
    }
  }

  const jsonPath = opt('json')
  if (jsonPath !== null) {
    const report = {
      generatedAt: new Date().toISOString(),
      mock,
      judgeModel: mock ? 'mock-scripted' : judgeModel,
      runs,
      minAccuracy,
      summary: {
        cases: total,
        matched,
        accuracy,
        falseNegatives,
        falsePositives,
        judgeErrors,
        runErrors,
        selfConsistency,
        passedThreshold: accuracy >= minAccuracy,
      },
      cases: results.map((r) => {
        const c = goldenCases.find((g) => g.id === r.id)!
        return {
          id: r.id,
          taskId: r.taskId,
          label: r.label,
          judge: r.judge,
          score: r.score,
          match: r.match,
          selfConsistency: r.selfConsistency,
          rationale: c.rationale,
          verdicts: r.verdicts.map((v) => ({
            verdict: v.verdict,
            score: v.score,
            reasons: v.reasons,
            violations: v.violations,
          })),
          errors: r.errors,
        }
      }),
    }
    const text = JSON.stringify(report, null, 2)
    if (jsonPath === '' || jsonPath === '-') console.log(text)
    else writeFileSync(path.resolve(jsonPath), text, 'utf8')
  }

  process.exit(accuracy >= minAccuracy ? 0 : 1)
}

await main()
