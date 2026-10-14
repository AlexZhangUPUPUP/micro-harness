/**
 * Unattended driver — ROADMAP P5 (`micro-harness run --auto`).
 *
 * An in-process equivalent of `scripts/auto-run.sh`: feed a queue of tasks to a
 * single harness, stop on completion, iteration count, wall-clock timeout, token
 * budget or cost budget, and report exactly why it stopped.
 */

import type { Harness } from './harness.ts'

export interface AutoRunOptions {
  harness: Harness
  tasks: string[]
  /** Hard cap on tasks attempted. Defaults to the queue length. */
  maxIterations?: number
  /** Stop once accumulated USD cost passes this. */
  maxCost?: number
  /** Stop once accumulated tokens (input+output) pass this. */
  maxTokens?: number
  /** Per-iteration wall-clock timeout. */
  timeoutMs?: number
  signal?: AbortSignal
  onIteration?: (info: { index: number; task: string; result: string; cost: number; tokens: number }) => void
}

export interface AutoRunResult {
  iterations: number
  cost: number
  tokens: number
  results: string[]
  stopReason: 'completed' | 'max-iterations' | 'timeout' | 'cost-budget' | 'token-budget' | 'aborted' | 'error'
}

export async function runAuto(options: AutoRunOptions): Promise<AutoRunResult> {
  const limit = Math.min(options.maxIterations ?? options.tasks.length, options.tasks.length)
  const tasks = options.tasks.slice(0, limit)
  const results: string[] = []
  let cost = 0
  let tokens = 0
  let stopReason: AutoRunResult['stopReason'] = 'completed'
  let active: AbortController | undefined

  const off = options.harness.hub.on((e) => {
    if (e.event.type !== 'usage') return
    cost += e.event.cost ?? 0
    tokens += e.event.input + e.event.output
    if (options.maxCost !== undefined && cost > options.maxCost) {
      stopReason = 'cost-budget'
      active?.abort(new Error(`cost budget exceeded ($${cost.toFixed(6)} > $${options.maxCost})`))
    }
    if (options.maxTokens !== undefined && tokens > options.maxTokens) {
      stopReason = 'token-budget'
      active?.abort(new Error(`token budget exceeded (${tokens} > ${options.maxTokens})`))
    }
  })

  try {
    for (let i = 0; i < tasks.length; i++) {
      if (options.signal?.aborted) {
        stopReason = 'aborted'
        break
      }
      if (options.maxCost !== undefined && cost > options.maxCost) {
        stopReason = 'cost-budget'
        break
      }
      if (options.maxTokens !== undefined && tokens > options.maxTokens) {
        stopReason = 'token-budget'
        break
      }

      const controller = new AbortController()
      active = controller
      const onAbort = (): void => controller.abort(options.signal?.reason)
      options.signal?.addEventListener('abort', onAbort)
      let timer: ReturnType<typeof setTimeout> | undefined
      if (options.timeoutMs) {
        timer = setTimeout(() => controller.abort(new Error(`iteration timed out after ${options.timeoutMs}ms`)), options.timeoutMs)
      }

      try {
        const result = await options.harness.send(tasks[i]!, controller.signal)
        results.push(result)
        options.onIteration?.({ index: i, task: tasks[i]!, result, cost, tokens })
      } catch (err) {
        const message = controller.signal.aborted
          ? String(controller.signal.reason?.message ?? controller.signal.reason ?? 'aborted')
          : String((err as Error)?.message || err)
        results.push(`error: ${message}`)
        if (stopReason === 'completed') stopReason = controller.signal.aborted && options.timeoutMs ? 'timeout' : 'error'
        break
      } finally {
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        active = undefined
      }
    }
  } finally {
    off()
  }

  // Report max-iterations when we simply ran out of queue under a lower cap.
  if (stopReason === 'completed' && limit < options.tasks.length) stopReason = 'max-iterations'
  return { iterations: results.length, cost, tokens, results, stopReason }
}

/** Parse a newline-delimited task file: blank lines and `#` comments ignored. */
export function parseTaskFile(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}
