#!/usr/bin/env bun
/**
 * CLI: `micro-harness [options] "one shot prompt"` or run with no prompt for an
 * interactive REPL that keeps the conversation (and context) between turns.
 *
 * Config comes from flags or the environment:
 *   MICRO_BASE_URL / OPENAI_BASE_URL   e.g. https://api.deepseek.com
 *   MICRO_API_KEY  / OPENAI_API_KEY
 *   MICRO_MODEL                        e.g. deepseek-chat
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import path from 'node:path'
import { Harness } from './harness.ts'
import { openaiProvider } from './provider.ts'
import { EventHub, type TaggedEvent } from './events.ts'
import { Trace } from './trace.ts'

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function opt(name: string, fallback?: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')) return process.argv[i + 1]
  return fallback
}

const quiet = flag('quiet')
const allowBash = flag('allow-bash')
const traceOn = flag('trace')
const cwd = path.resolve(opt('dir', process.cwd())!)
const maxSteps = Number(opt('max-steps', '24')) || 24
const maxContextTokens = Number(opt('max-context', '24000')) || 24_000
const model = opt('model', process.env.MICRO_MODEL || process.env.OPENAI_MODEL || 'deepseek-chat')!
const baseUrl = opt('base-url', process.env.MICRO_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com')!
const apiKey = process.env.MICRO_API_KEY || process.env.OPENAI_API_KEY || ''

const prompt = process.argv
  .slice(2)
  .filter((a) => !a.startsWith('--') && a !== opt('dir') && a !== opt('model') && a !== opt('max-steps'))
  .join(' ')
  .trim()

if (!apiKey) {
  console.error('missing API key: set MICRO_API_KEY (or OPENAI_API_KEY)')
  process.exit(1)
}

const trace = traceOn ? new Trace(path.join(cwd, 'traces')) : null
const hub = new EventHub()
hub.on((e: TaggedEvent) => {
  trace?.write(e)
  if (quiet) return
  const ev = e.event
  switch (ev.type) {
    case 'tool.call':
      console.log(`  → ${ev.name} ${JSON.stringify(ev.args).slice(0, 160)}`)
      break
    case 'tool.result':
      console.log(`  ${ev.ok ? '✓' : '✗'} ${ev.name}: ${ev.output.replace(/\n/g, ' ⏎ ').slice(0, 180)}`)
      break
    case 'context.trim':
      console.log(`  … context trimmed: dropped ${ev.dropped} messages (≈${ev.tokens} tokens)`)
      break
    case 'error':
      console.log(`  ! ${ev.message}`)
      break
  }
})

const harness = new Harness({
  provider: openaiProvider({ baseUrl, apiKey }),
  model,
  cwd,
  allowBash,
  maxSteps,
  maxContextTokens,
  hub,
})

if (!quiet) {
  console.error(`micro-harness · ${model} · cwd ${cwd}${allowBash ? ' · bash on' : ''}`)
}

if (prompt) {
  const answer = await harness.send(prompt)
  console.log('\n' + answer)
  process.exit(0)
}

const rl = createInterface({ input: stdin, output: stdout })
console.log('interactive mode — type a task, /exit to quit.\n')
for (;;) {
  const line = (await rl.question('› ')).trim()
  if (!line) continue
  if (line === '/exit' || line === '/quit') break
  const answer = await harness.send(line)
  console.log('\n' + answer + '\n')
}
rl.close()
