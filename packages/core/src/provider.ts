/**
 * The model boundary. The loop talks to a `Provider`, never to an HTTP API
 * directly — that is what makes swapping models (and faking one in tests) cheap.
 */

import { chat, chatStream, type ChatMessage, type DeltaHandler, type ToolDef, type Usage } from './model.ts'

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools: ToolDef[]
  signal?: AbortSignal
  /** 单次请求的输出上限；摘要等内部调用可独立限制。 */
  maxTokens?: number
  /** When provided, the provider should stream text/thinking deltas. */
  onDelta?: DeltaHandler
}

export interface ChatResponse {
  message: ChatMessage
  usage?: Usage
}

export interface Provider {
  name: string
  chat(req: ChatRequest): Promise<ChatResponse>
}

export interface OpenAIProviderConfig {
  name?: string
  baseUrl: string
  apiKey: string
  temperature?: number
  maxTokens?: number
}

/** Any OpenAI-compatible endpoint (DeepSeek, OpenAI, Ollama, vLLM, …). */
export function openaiProvider(cfg: OpenAIProviderConfig): Provider {
  return {
    name: cfg.name ?? 'openai-compatible',
    async chat(req) {
      const modelCfg = {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: req.model,
        temperature: cfg.temperature,
        // 内部请求可以收紧输出上限，但不能放宽 Provider 已配置的限制。
        maxTokens: req.maxTokens === undefined ? cfg.maxTokens
          : cfg.maxTokens === undefined ? req.maxTokens : Math.min(req.maxTokens, cfg.maxTokens),
      }
      const res = req.onDelta
        ? await chatStream(modelCfg, req.messages, req.tools, req.signal, req.onDelta)
        : await chat(modelCfg, req.messages, req.tools, req.signal)
      return { message: res.message, usage: res.usage }
    },
  }
}
