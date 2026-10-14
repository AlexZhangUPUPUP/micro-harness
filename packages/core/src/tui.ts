/**
 * A dependency-free terminal renderer for the event stream (ROADMAP P5).
 *
 * It is deliberately not ink: the loop already emits everything we need, so the
 * "TUI" is a stateful consumer that renders text deltas as they stream, turns
 * tool calls/results into compact cards, and stays out of the way when quiet.
 */

import type { TaggedEvent } from './events.ts'

export interface RendererOptions {
  /** Sink; defaults to stdout. */
  write?: (chunk: string) => void
  /** Force colour off (also honoured via NO_COLOR / non-TTY). */
  color?: boolean
  /** Show thinking deltas (default false). */
  showThinking?: boolean
  /** Show usage lines (default true). */
  showUsage?: boolean
}

const identity = (s: string): string => s

export class Renderer {
  readonly #write: (chunk: string) => void
  readonly #color: boolean
  readonly #showThinking: boolean
  readonly #showUsage: boolean
  #streaming = false
  #streamAgent: string | null = null
  #wroteHeader = false

  constructor(options: RendererOptions = {}) {
    this.#write = options.write ?? ((chunk) => process.stdout.write(chunk))
    this.#color = options.color ?? (!!process.stdout.isTTY && !process.env.NO_COLOR)
    this.#showThinking = options.showThinking ?? false
    this.#showUsage = options.showUsage ?? true
  }

  #style(code: number, text: string): string {
    if (!this.#color) return text
    return `\x1b[${code}m${text}\x1b[0m`
  }

  dim(text: string): string {
    return this.#style(2, text)
  }

  bold(text: string): string {
    return this.#style(1, text)
  }

  cyan(text: string): string {
    return this.#style(36, text)
  }

  green(text: string): string {
    return this.#style(32, text)
  }

  red(text: string): string {
    return this.#style(31, text)
  }

  yellow(text: string): string {
    return this.#style(33, text)
  }

  /** Close an in-progress streamed answer with a newline. */
  endStream(): void {
    if (this.#streaming) {
      this.#write('\n')
      this.#streaming = false
      this.#streamAgent = null
      this.#wroteHeader = false
    }
  }

  #ensureStream(agentId: string): void {
    if (this.#streaming && this.#streamAgent === agentId) return
    if (this.#streaming) this.#write('\n')
    else if (this.#wroteHeader) this.#write('\n')
    const label = agentId === 'main' || !agentId ? '' : this.dim(`[${agentId.split('/').pop()}] `)
    this.#write(this.cyan('◆ ') + label)
    this.#streaming = true
    this.#streamAgent = agentId
  }

  /** Render one tagged event. Unknown/new events are ignored gracefully. */
  onEvent(tagged: TaggedEvent): void {
    const event = tagged.event
    switch (event.type) {
      case 'text.delta':
        this.#ensureStream(tagged.agentId)
        this.#write(event.text)
        break
      case 'thinking.delta':
        if (!this.#showThinking) break
        this.endStream()
        this.#write(this.dim('  ⋯ ' + event.text.replace(/\n/g, '\n  ⋯ ')))
        break
      case 'tool.call': {
        this.endStream()
        this.#wroteHeader = true
        const args = JSON.stringify(event.args ?? {})
        const clipped = args.length > 160 ? args.slice(0, 160) + '…' : args
        this.#write(`  ${this.yellow('⚒')} ${this.bold(event.name)} ${this.dim(clipped)}\n`)
        break
      }
      case 'tool.result': {
        const mark = event.ok ? this.green('✓') : this.red('✗')
        const first = event.output.split('\n')[0] ?? ''
        const out = first.length > 160 ? first.slice(0, 160) + '…' : first
        this.#write(`    ${mark} ${this.dim(`${event.ms}ms`)} ${out}\n`)
        break
      }
      case 'permission.request':
        this.endStream()
        this.#write(`  ${this.yellow('?')} approval needed for ${this.bold(event.tool)}\n`)
        break
      case 'permission.result':
        this.#write(`    ${event.decision === 'allow' ? this.green('allowed') : this.red('denied')}\n`)
        break
      case 'context.trim':
        this.#write(this.dim(`  … trimmed ${event.dropped} messages (≈${event.tokens} tokens)\n`))
        break
      case 'usage': {
        if (!this.#showUsage) break
        const bits = [`${event.input}→${event.output} tok`]
        if (event.cacheRead) bits.push(`cache ${event.cacheRead}`)
        if (event.cost) bits.push(`$${event.cost.toFixed(6)}`)
        this.#write(this.dim(`  · usage ${bits.join(' · ')}\n`))
        break
      }
      case 'error':
        this.endStream()
        this.#write(`  ${this.red('!')} ${event.message}\n`)
        break
      case 'session.end':
        this.endStream()
        break
      default:
        break
    }
  }
}

export const noStyle = identity
