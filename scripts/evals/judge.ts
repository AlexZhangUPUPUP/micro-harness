/**
 * P10 LLM-as-judge — a *trustworthy* judge, not "call a model and believe it".
 *
 * The trust comes from three places:
 *   1. The system prompt is a strict, literal reviewer whose only standard is the
 *      rubric — it is told not to reward verbosity/flattery and that a missing
 *      requirement is a fail.
 *   2. The user prompt carries only the task, the answer, the rubric and the
 *      artifact contents — never the harness/config/model that produced the work,
 *      so the judge cannot play favourites.
 *   3. `parseVerdict` is strict: malformed output is `null`, which the caller turns
 *      into an *error*, never a pass.
 */

import { cacheReadTokens } from '../../packages/core/src/model.ts'
import type { Provider } from '../../packages/core/src/provider.ts'
import type { Task } from './tasks.ts'

export interface JudgeVerdict {
  verdict: 'pass' | 'fail'
  score: number
  reasons: string[]
  violations: string[]
}

export interface JudgeInput {
  task: Task
  answer: string
  artifacts: Record<string, string>
  transcript?: string
}

export interface JudgeCallResult extends JudgeVerdict {
  latencyMs: number
  input: number
  output: number
  cacheRead: number
  cost?: number
}

const ARTIFACT_CLIP = 4000
const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}\n… [truncated: ${s.length - max} more chars]` : s

const SYSTEM = `You are a strict, literal code-review judge. You grade an agent's finished work against a rubric — and against nothing else.

Rules you must obey:
- The rubric is the only standard. Ignore your own style preferences, the work's length, how confident or polite the answer sounds, and anything else not in the rubric.
- Never reward verbosity or flattery. A long, eloquent answer that misses a requirement is worse than a terse one that meets it.
- A missing requirement is a fail. Each \`mustPass\` item is required; the presence of any \`mustFail\` item is an automatic fail.
- Do not invent requirements, and do not pass work because it "mostly" satisfies the rubric.
- Judge actual artifact contents, not the agent's description of them. A file shown as \`(missing)\` does not exist.
- Answer with JSON only — no prose, no markdown fences — exactly this shape:
  {"verdict":"pass","score":0,"reasons":["..."],"violations":["..."]}
- \`verdict\` is "pass" only when every requirement is met; otherwise "fail".
- \`score\` is a number from 0 (nothing done) to 5 (every requirement met perfectly).
- \`reasons\` lists what the work did well; \`violations\` lists specific unmet requirements.`

export function buildJudgeMessages(input: JudgeInput): { system: string; user: string } {
  const rubric = input.task.rubric
  const lines: string[] = []

  lines.push('Judge the finished work below strictly against the rubric. The rubric is the only standard.', '')
  lines.push('## Task prompt')
  lines.push(input.task.prompt.trim() || '(no prompt)', '')
  lines.push('## Agent final answer')
  lines.push(input.answer.trim() || '(no answer)', '')

  lines.push('## Rubric')
  if (rubric) {
    lines.push('### criteria', rubric.criteria.trim() || '(no criteria)', '')
    if (rubric.mustPass?.length) {
      lines.push('### mustPass (each one is required; missing any one means `fail`)')
      for (const m of rubric.mustPass) lines.push(`- ${m}`)
      lines.push('')
    }
    if (rubric.mustFail?.length) {
      lines.push('### mustFail (presence of any one means `fail`)')
      for (const m of rubric.mustFail) lines.push(`- ${m}`)
      lines.push('')
    }
  } else {
    lines.push('(no rubric — grade on whether the task was completed as asked)', '')
  }

  const names = Object.keys(input.artifacts)
  if (names.length) {
    lines.push('## Artifacts (actual workspace contents)')
    for (const name of names) {
      lines.push(`### ${name}`, '```', clip(input.artifacts[name] ?? '(missing)', ARTIFACT_CLIP), '```', '')
    }
  }

  if (input.transcript) {
    lines.push('## Transcript', clip(input.transcript, ARTIFACT_CLIP), '')
  }

  lines.push('Now judge. Respond with JSON only, in the exact shape given in the system message.')

  return { system: SYSTEM, user: lines.join('\n') }
}

/** Extract the first balanced JSON object from text (tolerates prose/fences around it). */
function firstJsonObject(raw: string): unknown {
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => (typeof x === 'string' ? x : x == null ? '' : String(x)))
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Strict parser: first JSON object in the text, `verdict` ∈ {pass, fail}, score
 * coerced/clamped into 0–5, `reasons`/`violations` defaulted to `[]`. Returns
 * `null` on anything malformed — the caller must treat that as an error, not a pass.
 */
export function parseVerdict(raw: string): JudgeVerdict | null {
  if (!raw) return null
  const obj = firstJsonObject(raw)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  if (o.verdict !== 'pass' && o.verdict !== 'fail') return null

  let score: number
  if (typeof o.score === 'number' && Number.isFinite(o.score)) {
    score = o.score
  } else if (typeof o.score === 'string' && o.score.trim() !== '') {
    const n = Number(o.score)
    if (!Number.isFinite(n)) return null
    score = n
  } else {
    return null
  }
  score = Math.max(0, Math.min(5, score))

  return {
    verdict: o.verdict,
    score,
    reasons: stringArray(o.reasons),
    violations: stringArray(o.violations),
  }
}

/**
 * Run the judge for real. The provider should be constructed with temperature 0
 * (the `Provider` interface has no per-call temperature knob); this function always
 * passes `tools: []` and, when given, an `AbortSignal`. Throws on unparseable
 * output — a judge that cannot be parsed is an error, never a pass.
 */
export async function judgeTask(
  input: JudgeInput & {
    provider: Provider
    model: string
    pricing?: { input: number; output: number; inputCached?: number }
    signal?: AbortSignal
  },
): Promise<JudgeCallResult> {
  const started = Date.now()
  const { system, user } = buildJudgeMessages(input)
  const res = await input.provider.chat({
    model: input.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    tools: [],
    signal: input.signal,
  })

  const raw = typeof res.message.content === 'string' ? res.message.content : ''
  const usage = res.usage
  const inputTokens = usage?.prompt_tokens ?? 0
  const outputTokens = usage?.completion_tokens ?? 0
  const cacheRead = cacheReadTokens(usage)
  const pricing = input.pricing
  const cost = pricing
    ? ((inputTokens - cacheRead) / 1e6) * pricing.input +
      (cacheRead / 1e6) * (pricing.inputCached ?? pricing.input) +
      (outputTokens / 1e6) * pricing.output
    : undefined

  const verdict = parseVerdict(raw)
  if (!verdict) {
    throw new Error(`judge returned unparseable output: ${raw.slice(0, 300) || '(empty)'}`)
  }

  return {
    ...verdict,
    latencyMs: Date.now() - started,
    input: inputTokens,
    output: outputTokens,
    cacheRead,
    ...(cost !== undefined ? { cost } : {}),
  }
}

const DEFAULT_PASS: JudgeVerdict = {
  verdict: 'pass',
  score: 5,
  reasons: ['The scripted (offline) judge found the work plausible against the rubric.'],
  violations: [],
}

function isSingleVerdict(v: Record<string, JudgeVerdict> | JudgeVerdict): v is JudgeVerdict {
  return typeof (v as JudgeVerdict).verdict === 'string'
}

/**
 * An offline judge for `--mock` runs: it still builds the real prompt and re-parses
 * its own verdict through `parseVerdict`, so prompt build + parse + verdict handling
 * are exercised with no network. Pass one verdict, or a map keyed by task id.
 */
export function makeScriptedJudge(
  verdicts: Record<string, JudgeVerdict> | JudgeVerdict,
): (input: JudgeInput) => Promise<JudgeVerdict> {
  return async (input) => {
    const messages = buildJudgeMessages(input)
    if (!messages.system.trim() || !messages.user.trim()) {
      throw new Error('scripted judge: empty prompt')
    }
    const verdict = isSingleVerdict(verdicts) ? verdicts : verdicts[input.task.id] ?? DEFAULT_PASS
    const parsed = parseVerdict(JSON.stringify(verdict))
    if (!parsed) throw new Error('scripted judge: verdict failed strict parsing')
    return parsed
  }
}
