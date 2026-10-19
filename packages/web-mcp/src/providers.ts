/**
 * Search backends, chosen by config so the default needs no key and the rest
 * are a one-line switch.
 *
 *   bing    (default)  cn.bing.com HTML — reachable and parseable where the
 *                      global engines are blocked, no key
 *   baidu              baidu.com HTML — no key, best effort
 *   bocha              博查 Web Search API — POST + Bearer key, JSON
 *   deepseek           DeepSeek Search API — POST + Bearer key, JSON
 *   searxng            a SearXNG instance (JSON API) — no key, you host it
 *
 * Every provider returns the same shape, so the model never sees which one ran.
 */

import { request as httpsRequest } from 'node:https'
import { fetchText, resolvePublic, WebError } from './net.ts'
import { decodeEntities, htmlToText } from './html.ts'
import type { WebConfig } from './config.ts'

export interface SearchResult {
  title: string
  url: string
  snippet?: string
}

export interface SearchProvider {
  id: string
  /** True when the provider needs an API key or a URL we do not have. */
  configured(cfg: WebConfig): boolean
  search(query: string, maxResults: number, cfg: WebConfig): Promise<SearchResult[]>
}

const clean = (s: string): string => decodeEntities(htmlToText(s)).replace(/\s+/g, ' ').trim()

function needKey(id: string, key: string): string {
  if (!key) throw new WebError('network', `search provider "${id}" needs an API key (set it in the mcp.json env block)`)
  return key
}

/** POST JSON through the same pinned, SSRF-checked transport as GET. */
function postJson(url: URL, body: unknown, cfg: WebConfig, headers: Record<string, string>): Promise<{ status: number; text: string }> {
  return resolvePublic(url.hostname).then(
    (pinned) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const payload = JSON.stringify(body)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
        const req = httpsRequest(
          {
            protocol: 'https:',
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
              'user-agent': cfg.userAgent,
              ...headers,
            },
            signal: controller.signal,
            lookup: ((_h: string, options: unknown, cb: (...a: unknown[]) => void) => {
              const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all
              if (all) cb(null, [{ address: pinned.address, family: pinned.family }])
              else cb(null, pinned.address, pinned.family)
            }) as never,
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
            res.on('error', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
          },
        )
        req.on('error', (err: Error) => {
          clearTimeout(timer)
          reject(new WebError(err.name === 'AbortError' ? 'timeout' : 'network', err.message))
        })
        req.on('close', () => clearTimeout(timer))
        req.end(payload)
      }),
  )
}

/** Parse a cn.bing.com results page. Exported so it can be tested from a fixture. */
export function parseBing(html: string, maxResults: number): SearchResult[] {
  const out: SearchResult[] = []
  const chunks = html.split(/<li class="b_algo"/i).slice(1)
  for (const chunk of chunks) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(chunk)
    if (!a) continue
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(chunk)
    out.push({
      title: clean(a[2] ?? ''),
      url: decodeEntities(a[1] ?? ''),
      snippet: snippet ? clean(snippet[1] ?? '') : undefined,
    })
    if (out.length >= maxResults) break
  }
  return out
}

/** Parse a baidu.com results page. Best effort: Baidu's markup churns. */
export function parseBaidu(html: string, maxResults: number): SearchResult[] {
  const out: SearchResult[] = []
  const re = /<h3[^>]*class="[^"]*t[^"]*"[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) && out.length < maxResults) {
    const href = decodeEntities(m[1] ?? '')
    if (!href.startsWith('http')) continue
    out.push({ title: clean(m[2] ?? ''), url: href })
  }
  return out
}

const bing: SearchProvider = {
  id: 'bing',
  configured: () => true,
  async search(query, maxResults, cfg) {
    const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${Math.min(maxResults, 20)}`
    const page = await fetchText(url, {
      maxBytes: cfg.maxBytes,
      maxChars: 400_000,
      timeoutMs: cfg.timeoutMs,
      userAgent: cfg.userAgent,
    })
    return parseBing(page.text, maxResults)
  },
}

const baidu: SearchProvider = {
  id: 'baidu',
  configured: () => true,
  async search(query, maxResults, cfg) {
    const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${Math.min(maxResults, 20)}`
    const page = await fetchText(url, {
      maxBytes: cfg.maxBytes,
      maxChars: 400_000,
      timeoutMs: cfg.timeoutMs,
      userAgent: cfg.userAgent,
    })
    return parseBaidu(page.text, maxResults)
  },
}

interface BochaResponse {
  data?: { webPages?: { value?: Array<{ name?: string; url?: string; snippet?: string; summary?: string }> } }
}

const bocha: SearchProvider = {
  id: 'bocha',
  configured: (cfg) => Boolean(cfg.bochaKey),
  async search(query, maxResults, cfg) {
    const key = needKey('bocha', cfg.bochaKey)
    const res = await postJson(
      new URL('https://api.bochaai.com/v1/web-search'),
      { query, count: Math.min(maxResults, 20), summary: true },
      cfg,
      { authorization: `Bearer ${key}` },
    )
    if (res.status < 200 || res.status >= 300) {
      throw new WebError('network', `bocha returned HTTP ${res.status}: ${res.text.slice(0, 200)}`)
    }
    let parsed: BochaResponse
    try {
      parsed = JSON.parse(res.text) as BochaResponse
    } catch {
      throw new WebError('network', 'bocha returned non-JSON')
    }
    return (parsed.data?.webPages?.value ?? [])
      .slice(0, maxResults)
      .map((v) => ({ title: String(v.name ?? ''), url: String(v.url ?? ''), snippet: v.snippet ?? v.summary }))
      .filter((r) => r.url)
  },
}

interface DeepseekResponse {
  results?: Array<{ title?: string; url?: string; snippet?: string; summary?: string; site_name?: string | null }>
}

/**
 * Parse the Search API response. `summary` (600–800 characters) is written for a
 * model, so prefer it over the UI-sized `snippet`.
 */
export function parseDeepseek(json: DeepseekResponse, maxResults: number): SearchResult[] {
  return (json.results ?? [])
    .slice(0, maxResults)
    .map((r) => ({
      title: String(r.title || r.site_name || ''),
      url: String(r.url ?? ''),
      snippet: r.summary || r.snippet,
    }))
    .filter((r) => r.url)
}

const deepseek: SearchProvider = {
  id: 'deepseek',
  configured: (cfg) => Boolean(cfg.deepseekKey),
  async search(query, maxResults, cfg) {
    const key = needKey('deepseek', cfg.deepseekKey)
    const res = await postJson(
      new URL('https://api.deepseek.com/v1/tools/search'),
      { query, count: Math.min(maxResults, 20) },
      cfg,
      { authorization: `Bearer ${key}` },
    )
    if (res.status < 200 || res.status >= 300) {
      throw new WebError('network', `deepseek returned HTTP ${res.status}: ${res.text.slice(0, 200)}`)
    }
    let parsed: DeepseekResponse
    try {
      parsed = JSON.parse(res.text) as DeepseekResponse
    } catch {
      throw new WebError('network', 'deepseek returned non-JSON')
    }
    return parseDeepseek(parsed, maxResults)
  },
}

const searxng: SearchProvider = {
  id: 'searxng',
  configured: (cfg) => Boolean(cfg.searxngUrl),
  async search(query, maxResults, cfg) {
    if (!cfg.searxngUrl) throw new WebError('network', 'provider "searxng" needs MICRO_SEARXNG_URL')
    const url = `${cfg.searxngUrl.replace(/\/+$/, '')}/search?q=${encodeURIComponent(query)}&format=json`
    const page = await fetchText(url, {
      maxBytes: cfg.maxBytes,
      maxChars: 400_000,
      timeoutMs: cfg.timeoutMs,
      userAgent: cfg.userAgent,
    })
    const parsed = JSON.parse(page.text) as { results?: Array<{ title?: string; url?: string; content?: string }> }
    return (parsed.results ?? [])
      .slice(0, maxResults)
      .map((r) => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: r.content }))
      .filter((r) => r.url)
  },
}

const PROVIDERS: Record<string, SearchProvider> = { bing, baidu, bocha, deepseek, searxng }

export function providerIds(): string[] {
  return Object.keys(PROVIDERS)
}

export function resolveProvider(id: string, cfg: WebConfig): SearchProvider {
  const provider = PROVIDERS[id]
  if (!provider) {
    throw new WebError('network', `unknown search provider "${id}" (known: ${providerIds().join(', ')})`)
  }
  if (!provider.configured(cfg)) {
    throw new WebError('network', `search provider "${id}" is not configured`)
  }
  return provider
}
