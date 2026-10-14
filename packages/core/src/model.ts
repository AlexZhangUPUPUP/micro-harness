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
