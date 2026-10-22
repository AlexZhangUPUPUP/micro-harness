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

/** One part of a multimodal message, in the OpenAI-compatible wire shape. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | ContentPart[] | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

/**
 * Build a user message's `content` for the wire. Returns the plain string when
 * there are no images (so text-only prompts are unchanged) and the OpenAI
 * multimodal part list otherwise, with each image as a base64 data URL.
 */
export function userContent(
  text: string,
  images?: Array<{ mimeType: string; data: string }>,
): string | ContentPart[] {
  if (!images || images.length === 0) return text
  return [
    { type: 'text', text },
    ...images.map(
      (img): ContentPart => ({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.data}` },
      }),
    ),
  ]
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
  completion_tokens_details?: { reasoning_tokens?: number } // OpenAI-shaped reasoning
  cache_read_input_tokens?: number // Anthropic-shaped
}

/**
 * How many of this request's input tokens were served from the provider's prompt
 * cache. Providers report this under different names, so normalize here rather than
 * making every caller know three dialects.
 */
/** Reasoning tokens billed as output, when the provider reports them. */
export function reasoningTokens(usage?: Usage): number {
  return Number(usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0
}

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

/** 流式响应累积状态，完成标记与输出内容分别记录。 */
interface StreamState {
  content: string
  toolCalls: ToolCall[]
  usage?: Usage
  completed: boolean
  done?: boolean
}

/** 合并工具调用分片，保留兼容接口要求的 function 类型。 */
function appendToolCalls(state: StreamState, delta: StreamDeltaPayload): void {
  // 按提供方给出的索引累积同一个调用的名称与参数。
  for (const tc of delta.tool_calls ?? []) {
    const index = tc.index ?? 0
    if (!Number.isInteger(index) || index < 0) throw new Error('invalid streamed tool-call index')
    const slot = (state.toolCalls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } })
    if (tc.id) slot.id = tc.id
    if (tc.function?.name) slot.function.name += tc.function.name
    if (tc.function?.arguments) slot.function.arguments += tc.function.arguments
  }
}

/** 解析数据帧；仅忽略 SSE 注释等非 data 行，不吞解析或回调异常。 */
function handleStreamLine(line: string, state: StreamState, onDelta?: DeltaHandler): void {
  // 完成标记允许没有 finish_reason 的兼容服务正常结束。
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return
  const data = trimmed.slice(5).trim()
  if (data === '[DONE]') { state.completed = true; state.done = true; return }
  if (!data) return
  const payload = JSON.parse(data) as {
    choices?: Array<{ delta?: StreamDeltaPayload; finish_reason?: string | null }>
    usage?: Usage
    error?: unknown
  }
  // 服务端错误或非响应对象不能作为成功输出继续执行工具。
  if (!payload || typeof payload !== 'object' || payload.error || !Array.isArray(payload.choices)) {
    throw new Error('invalid model stream payload')
  }
  if (payload.usage) state.usage = payload.usage
  const choice = payload.choices[0]
  const reason = choice?.finish_reason
  if (reason) {
    if (!['stop', 'tool_calls', 'function_call'].includes(reason)) {
      throw new Error(`model stream ended unsuccessfully: ${reason}`)
    }
    state.completed = true
  }
  // 内容回调异常向上传递，防止调用方失败被当作畸形帧忽略。
  const delta = choice?.delta
  if (!delta) return
  if (delta.content) {
    state.content += delta.content
    onDelta?.({ type: 'text', text: delta.content })
  }
  if (delta.reasoning_content) onDelta?.({ type: 'thinking', text: delta.reasoning_content })
  appendToolCalls(state, delta)
}

/** 消费字节流并校验完成状态；异常时取消读取，始终释放 Reader 锁。 */
async function readChatStream(body: ReadableStream<Uint8Array>, onDelta?: DeltaHandler): Promise<StreamState> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const state: StreamState = { content: '', toolCalls: [], completed: false }
  let buffer = ''
  let exhausted = false
  try {
    // 保留跨网络分片的残行，EOF 时也解析最后一行。
    while (!exhausted) {
      const { done, value } = await reader.read()
      exhausted = done
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        handleStreamLine(line, state, onDelta)
        if (state.done) break
      }
      // DONE 代表协议结束，不等待服务端关闭长连接。
      if (state.done) break
    }
    if (!state.done && buffer.trim()) handleStreamLine(buffer, state, onDelta)
    if (!state.completed) throw new Error('model stream ended before completion marker')
    return state
  } finally {
    // 取消失败不覆盖原始解析、网络或调用方异常。
    if (!exhausted) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** 请求流式响应，只有明确完成后才返回可执行的助手消息。 */
export async function chatStream(
  cfg: ModelConfig,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal | undefined,
  onDelta?: DeltaHandler,
): Promise<ChatResult> {
  // 构造与普通聊天兼容的请求，并启用用量尾帧。
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const body: Record<string, unknown> = {
    model: cfg.model, messages, temperature: cfg.temperature ?? 0.2,
    stream: true, stream_options: { include_usage: true },
  }
  if (cfg.maxTokens) body.max_tokens = cfg.maxTokens
  if (tools.length) { body.tools = tools; body.tool_choice = 'auto' }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body), signal,
  })
  // HTTP 错误与空响应体明确失败，避免返回空的成功答案。
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`model request failed: HTTP ${res.status} ${text.slice(0, 500)}`)
  }
  if (!res.body) throw new Error('model returned no response body for stream')
  const state = await readChatStream(res.body, onDelta)
  // 保留原有缺失调用 ID 的兼容行为。
  state.toolCalls.forEach((call, index) => {
    if (call && !call.id) call.id = `call_${index}_${Date.now().toString(36)}`
  })
  const calls = state.toolCalls.filter((call) => call && (call.id || call.function.name || call.function.arguments))
  return {
    message: { role: 'assistant', content: state.content || null, tool_calls: calls.length ? calls : undefined },
    usage: state.usage,
  }
}
