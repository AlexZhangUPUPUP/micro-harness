/**
 * The model boundary. The loop talks to a `Provider`, never to an HTTP API
 * directly — that is what makes swapping models (and faking one in tests) cheap.
 */

import { chat, type ChatMessage, type ToolDef, type Usage } from './model.ts'

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools: ToolDef[]
  signal?: AbortSignal
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
      const res = await chat(
        {
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          model: req.model,
          temperature: cfg.temperature,
          maxTokens: cfg.maxTokens,
        },
        req.messages,
        req.tools,
        req.signal,
      )
      return { message: res.message, usage: res.usage }
    },
  }
}
