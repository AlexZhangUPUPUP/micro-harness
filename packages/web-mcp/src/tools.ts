/**
 * The two model-facing tools. They are built from a config, so the boot-level
 * `MICRO_WEB` decides which of them exist at all, and the runtime toggle is
 * re-checked on every call (the soft switch the GUI flips).
 */

import { capabilities, runtimeEnabled, runtimeSettings, type WebConfig } from './config.ts'
import { cacheGet, cacheKey, cacheSet } from './cache.ts'
import { fetchText, WebError, type FetchedText } from './net.ts'
import { htmlToText, titleOf } from './html.ts'
import { resolveProvider } from './providers.ts'

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>
}

const REFUSAL =
  'Web access is currently disabled by the runtime switch (~/.micro-harness/web.json). ' +
  'Enable it in the GUI, or delete that file, and try again.'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function errorResult(err: unknown): { text: string; isError: true } {
  const message = err instanceof WebError ? `${err.code}: ${err.message}` : String((err as Error)?.message ?? err)
  return { text: `web request failed — ${message}`, isError: true }
}

export function buildTools(cfg: WebConfig): ToolDef[] {
  const caps = capabilities(cfg.mode)
  const tools: ToolDef[] = []

  if (caps.fetch) {
    tools.push({
      name: 'web_fetch',
      description:
        'Fetch one URL and return its readable text (HTML is converted to plain text). ' +
        'Only public https addresses; redirects to another host are reported instead of followed. ' +
        'Text is capped at 20000 characters by default. Fetch only a page you will cite, and do not fetch the same URL twice.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'absolute https URL to fetch' },
          maxChars: {
            type: 'integer',
            description: 'cap on returned characters (optional; default 20000, never above the server cap)',
          },
        },
        required: ['url'],
      },
      async run(args) {
        if (!runtimeEnabled(cfg.toggleFile)) return { text: REFUSAL, isError: true }
        const url = String(args.url ?? '').trim()
        if (!url) return { text: 'web_fetch: url is required', isError: true }
        const maxChars = Number(args.maxChars) > 0 ? Math.min(Number(args.maxChars), cfg.maxChars) : cfg.maxChars
        const key = cacheKey(url, maxChars, cfg.maxBytes)
        let res: FetchedText | undefined = cacheGet(key)
        const fromCache = res !== undefined
        try {
          if (!res) {
            const fetched = await fetchText(url, {
              maxBytes: cfg.maxBytes,
              maxChars,
              timeoutMs: cfg.timeoutMs,
              userAgent: cfg.userAgent,
            })
            // Redirects are reported, not followed, and are not worth caching.
            if (!fetched.redirectTo) cacheSet(key, fetched)
            res = fetched
          }
          if (res.redirectTo) {
            return { text: `${res.finalUrl} → ${res.redirectTo}\n(redirected to a different host; fetch that URL if you want it)` }
          }
          const isHtml = /html|xml/i.test(res.contentType)
          const title = isHtml ? titleOf(res.text) : undefined
          const body = isHtml ? htmlToText(res.text) : res.text
          const header = [
            `URL: ${res.finalUrl}`,
            `Status: ${res.status} · ${res.contentType} · ${fmtBytes(res.bytes)}${res.truncated ? ' · truncated' : ''}${fromCache ? ' · cached' : ''}`,
            title ? `Title: ${title}` : '',
          ]
            .filter(Boolean)
            .join('\n')
          return { text: `${header}\n\n${body}` }
        } catch (err) {
          return errorResult(err)
        }
      },
    })
  }

  if (caps.search) {
    tools.push({
      name: 'web_search',
      description:
        'Search the web and return titles, URLs and snippets. One or two calls usually suffice; ' +
        'fetch a page only when its snippet is not enough to answer.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'search query' },
          maxResults: { type: 'integer', description: 'number of results (default 5)' },
        },
        required: ['query'],
      },
      async run(args) {
        const settings = runtimeSettings(cfg.toggleFile)
        if (!settings.enabled) return { text: REFUSAL, isError: true }
        const query = String(args.query ?? '').trim()
        if (!query) return { text: 'web_search: query is required', isError: true }
        const maxResults = Number(args.maxResults) > 0 ? Math.min(Number(args.maxResults), 20) : 5
        const id = String(args.provider ?? settings.provider ?? cfg.provider).toLowerCase()
        try {
          const provider = resolveProvider(id, cfg)
          const results = await provider.search(query, maxResults, cfg)
          if (results.length === 0) return { text: `no results for "${query}" (provider: ${id})` }
          const lines = results.map(
            (r, i) => `${i + 1}. ${r.title || '(no title)'}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`,
          )
          return { text: `${results.length} result(s) for "${query}" via ${id}\n\n${lines.join('\n\n')}` }
        } catch (err) {
          return errorResult(err)
        }
      },
    })
  }

  return tools
}
