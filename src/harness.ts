/**
 * The agent loop.
 *
 *   user → model → (tool calls? execute → feed results back) → … → final answer
 *
 * Everything else in this repo exists to serve this ~40-line loop: `model.ts`
 * talks to the LLM, `tools.ts` executes what it asks for, `context.ts` keeps the
 * conversation inside the window. Errors from tools are fed back as normal
 * messages so the model can recover, and a step limit prevents runaway loops.
 */

import { chat, type ChatMessage, type ModelConfig, type Usage } from './model.ts'
import { dispatch, makeTools, toolDefs, type Tool, type ToolContext } from './tools.ts'
import { estimateTokens, trimMessages } from './context.ts'

export type HarnessEvent =
  | { type: 'step'; n: number }
  | { type: 'assistant'; text: string }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'tool_result'; name: string; output: string; isError: boolean }
  | { type: 'trim'; dropped: number; tokens: number }
  | { type: 'usage'; usage: Usage }

export interface HarnessOptions {
  model: ModelConfig
  cwd: string
  allowBash?: boolean
  maxSteps?: number
  maxContextTokens?: number
  systemPrompt?: string
  onEvent?: (e: HarnessEvent) => void
}

const DEFAULT_SYSTEM = `You are a careful coding agent working inside the directory {{cwd}}.
Use the provided tools to inspect and modify files; prefer reading a file before writing it.
Work autonomously — do not ask for confirmation. When the task is complete, reply with a short summary of what you did.`

export class Harness {
  readonly messages: ChatMessage[]
  private model: ModelConfig
  private tools: Tool[]
  private toolCtx: ToolContext
  private maxSteps: number
  private maxContextTokens: number
  private onEvent?: (e: HarnessEvent) => void

  constructor(opts: HarnessOptions) {
    this.model = opts.model
    this.tools = makeTools()
    this.toolCtx = { cwd: opts.cwd, allowBash: !!opts.allowBash }
    this.maxSteps = opts.maxSteps ?? 24
    this.maxContextTokens = opts.maxContextTokens ?? 24_000
    this.onEvent = opts.onEvent
    const system = (opts.systemPrompt ?? DEFAULT_SYSTEM).replace('{{cwd}}', opts.cwd)
    this.messages = [{ role: 'system', content: system }]
  }

  private emit(e: HarnessEvent): void {
    this.onEvent?.(e)
  }

  /** Run one user turn to completion and return the final assistant text. */
  async send(prompt: string): Promise<string> {
    this.messages.push({ role: 'user', content: prompt })

    for (let step = 1; step <= this.maxSteps; step++) {
      this.emit({ type: 'step', n: step })

      const { messages, dropped } = trimMessages(this.messages, this.maxContextTokens)
      if (dropped > 0) {
        this.messages.splice(0, this.messages.length, ...messages)
        this.emit({ type: 'trim', dropped, tokens: estimateTokens(messages) })
      }

      const { message, usage } = await chat(this.model, this.messages, toolDefs(this.tools))
      this.messages.push(message)
      if (usage) this.emit({ type: 'usage', usage })
      if (message.content) this.emit({ type: 'assistant', text: String(message.content) })

      const calls = message.tool_calls || []
      if (calls.length === 0) return String(message.content ?? '')

      for (const call of calls) {
        const name = call.function?.name || ''
        let args: unknown = {}
        try {
          args = JSON.parse(call.function?.arguments || '{}')
        } catch {
          /* keep raw */
        }
        this.emit({ type: 'tool_call', name, args })

        const result = await dispatch(this.tools, name, call.function?.arguments || '{}', this.toolCtx)
        this.emit({ type: 'tool_result', name, output: result.output, isError: !!result.isError })

        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name,
          content: result.output,
        })
      }
    }

    return '(reached the step limit without a final answer)'
  }
}
