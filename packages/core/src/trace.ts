/**
 * A run transcript, as JSONL — every event the loop emitted, one object per line.
 * Observability is cheap when the loop already emits events.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

export class Trace {
  readonly file: string

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    this.file = path.join(dir, `run-${stamp}.jsonl`)
  }

  write(obj: unknown): void {
    try {
      appendFileSync(this.file, JSON.stringify({ t: Date.now(), ...(obj as object) }) + '\n')
    } catch {
      /* tracing must never break the run */
    }
  }
}
