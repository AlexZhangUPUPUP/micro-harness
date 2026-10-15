/**
 * Model I/O — a tiny OpenAI-compatible chat-completions client.
 *
 * No SDK, no dependencies: one `fetch` call with retries on 429/5xx. The only
 * thing the harness needs from a model is "messages in, assistant message out,
 * possibly with tool calls".
 */

export interface ToolCall {
  id: string
  type?: string
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  /** Provider-specific prompt-cache reporting; use `cacheReadTokens()` to read it. */
  prompt_cache_hit_tokens?: number // DeepSeek
  prompt_cache_miss_tokens?: number // DeepSeek
  prompt_tokens_details?: { cached_tokens?: number } // OpenAI
  cache_read_input_tokens?: number // Anthropic-shaped
}

/**
 * How many of this request's input tokens were served from the provider's prompt
 * cache. Providers report this under different names, so normalize here rather than
 * making every caller know three dialects.
 */
export function cacheReadTokens(usage?: Usage): number {
  if (!usage) return 0
  return (
    usage.prompt_cache_hit_tokens ??
    usage.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    0
  )
}

export interface ModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  temperature?: number
  maxTokens?: number
}

export interface ChatResult {
  message: ChatMessage
  usage?: Usage
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A streamed slice of a model response. */
export interface StreamDelta {
  type: 'text' | 'thinking'
  text: string
}

export type DeltaHandler = (delta: StreamDelta) => void

interface StreamDeltaPayload {
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
}

export async function chat(
  cfg: ModelConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal?: AbortSignal,
): Promise<ChatResult> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature ?? 0.2,
  }
  if (cfg.maxTokens) body.max_tokens = cfg.maxTokens
  if (tools.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  let lastErr: unknown
  for (let attempt = 1; attempt <= 4; attempt++) {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      lastErr = err
      await sleep(300 * attempt)
      continue
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
        await sleep(400 * attempt * attempt)
        continue
      }
      throw new Error(`model request failed: HTTP ${res.status} ${text.slice(0, 500)}`)
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: ChatMessage }>
      usage?: Usage
    }
    const choice = data.choices?.[0]
    if (!choice?.message) {
      throw new Error('model returned no choices: ' + JSON.stringify(data).slice(0, 300))
    }
    return {
      message: {
        role: 'assistant',
        content: choice.message.content ?? null,
        tool_calls: choice.message.tool_calls,
      },
      usage: data.usage,
    }
  }

  throw new Error('model request failed after retries: ' + String((lastErr as Error)?.message || lastErr))
}

/**
 * Streaming variant of `chat`: reads an OpenAI-compatible SSE stream, forwards
 * text/thinking deltas to `onDelta`, and still returns the fully-assembled
 * assistant message (including tool calls) so the loop is unchanged.
 */
export async function chatStream(
  cfg: ModelConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal | undefined,
  onDelta?: DeltaHandler,
): Promise<ChatResult> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: cfg.temperature ?? 0.2,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (cfg.maxTokens) body.max_tokens = cfg.maxTokens
  if (tools.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`model request failed: HTTP ${res.status} ${text.slice(0, 500)}`)
  }
  if (!res.body) throw new Error('model returned no response body for stream')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let reasoning = ''
  const toolCalls: ToolCall[] = []
  let usage: Usage | undefined

  const handle = (payload: { choices?: Array<{ delta?: StreamDeltaPayload }>; usage?: Usage }): void => {
    if (payload.usage) usage = payload.usage
    const delta = payload.choices?.[0]?.delta
    if (!delta) return
    if (delta.content) {
      content += delta.content
      onDelta?.({ type: 'text', text: delta.content })
    }
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content
      onDelta?.({ type: 'thinking', text: delta.reasoning_content })
    }
    for (const tc of delta.tool_calls ?? []) {
      const index = tc.index ?? 0
      const slot = (toolCalls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } })
      // Some providers omit `type` on streamed tool-call deltas, but the value
      // MUST be `function` when the message is sent back or the API rejects it.
      slot.type = 'function'
      if (tc.id) slot.id = tc.id
      if (tc.function?.name) slot.function.name += tc.function.name
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        handle(JSON.parse(data) as { choices?: Array<{ delta?: StreamDeltaPayload }>; usage?: Usage })
      } catch {
        /* ignore malformed keep-alive fragments */
      }
    }
  }

  toolCalls.forEach((c, i) => {
    if (c && !c.id) c.id = `call_${i}_${Date.now().toString(36)}`
  })
  const calls = toolCalls.filter((c) => c && (c.id || c.function.name || c.function.arguments))
  return {
    message: {
      role: 'assistant',
      content: content || null,
      tool_calls: calls.length ? calls : undefined,
    },
    usage,
  }
}
