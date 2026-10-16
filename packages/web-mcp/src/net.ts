/**
 * A small, safe text fetcher — no dependencies, no credentials.
 *
 * The dangerous part of "give the model a URL" is SSRF: a prompt can point it at
 * `http://127.0.0.1:…` or the cloud metadata endpoint. So we resolve the host,
 * refuse anything that is not a public address, and then **pin the validated
 * address** for the connection (a custom `lookup`), which also closes the
 * DNS-rebinding window between check and connect.
 */

import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'

export class WebError extends Error {
  constructor(
    readonly code:
      | 'bad-url'
      | 'blocked-address'
      | 'unsupported-scheme'
      | 'unsupported-content-type'
      | 'too-large'
      | 'redirect'
      | 'timeout'
      | 'network',
    message: string,
  ) {
    super(message)
    this.name = 'WebError'
  }
}

/** Public, routable address? Rejects loopback, private, link-local, CGNAT, metadata, multicast. */
export function isPublicAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const lower = ip.toLowerCase()
    if (lower === '::1' || lower === '::') return false
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower)
    if (mapped) return isPublicAddress(mapped[1]!)
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false // fc00::/7
    if (/^fe[89ab]/.test(lower)) return false // fe80::/10
    if (lower.startsWith('2001:db8')) return false // documentation
    if (lower.startsWith('ff')) return false // multicast
    return true
  }
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b] = parts as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT
  if (a === 169 && b === 254) return false // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && (b === 0 || b === 168)) return false
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false
  if (a === 203 && b === 0) return false
  if (a >= 224) return false // multicast + reserved
  return true
}

/** A host we are willing to resolve at all: a DNS name with a dot, not `localhost`. */
export function isFetchableHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return false
  if (h.endsWith('.local')) return false
  return h.includes('.')
}

export interface Resolved {
  host: string
  address: string
  family: number
}

/** Resolve a host and require *every* address it maps to be public. */
export async function resolvePublic(host: string): Promise<Resolved> {
  if (!isFetchableHost(host)) {
    throw new WebError('blocked-address', `refusing to fetch ${host}: not a public host name`)
  }
  // A literal address skips DNS.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (!isPublicAddress(host)) throw new WebError('blocked-address', `refusing to fetch non-public address ${host}`)
    return { host, address: host, family: host.includes(':') ? 6 : 4 }
  }
  let addrs: Array<{ address: string; family: number }>
  try {
    addrs = await dnsLookup(host, { all: true })
  } catch {
    throw new WebError('network', `could not resolve ${host}`)
  }
  if (addrs.length === 0) throw new WebError('network', `could not resolve ${host}`)
  for (const a of addrs) {
    if (!isPublicAddress(a.address)) {
      throw new WebError('blocked-address', `refusing to fetch ${host}: resolves to non-public ${a.address}`)
    }
  }
  const first = addrs[0]!
  return { host, address: first.address, family: first.family }
}

export interface FetchTextOptions {
  maxBytes: number
  maxChars: number
  timeoutMs: number
  userAgent: string
  /** How many same-origin redirects to follow before reporting instead. */
  maxRedirects?: number
}

export interface FetchedText {
  status: number
  finalUrl: string
  contentType: string
  /** Decoded body, already capped to `maxChars`. */
  text: string
  bytes: number
  truncated: boolean
  /** Set when a redirect left the origin and we stopped. */
  redirectTo?: string
}

const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|rss\+xml|atom\+xml)|image\/svg)/i

function normalizeUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WebError('bad-url', `not a URL: ${raw}`)
  }
  if (url.protocol === 'http:') url.protocol = 'https:' // upgrade in place
  if (url.protocol !== 'https:') throw new WebError('unsupported-scheme', `unsupported scheme ${url.protocol}`)
  if (url.username || url.password) throw new WebError('bad-url', 'refusing a URL with credentials')
  return url
}

function once(url: URL, opts: FetchTextOptions, pinned: Resolved): Promise<{
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
  truncated: boolean
}> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    const req = httpsRequest(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'user-agent': opts.userAgent,
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5',
          'accept-language': 'en,zh-CN;q=0.8',
        },
        signal: controller.signal,
        // Pin the address we validated instead of letting the socket re-resolve.
        lookup: ((_h: string, options: unknown, cb: (...a: unknown[]) => void) => {
          const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all
          if (all) cb(null, [{ address: pinned.address, family: pinned.family }])
          else cb(null, pinned.address, pinned.family)
        }) as never,
      },
      (res) => {
        const chunks: Buffer[] = []
        let bytes = 0
        let truncated = false
        res.on('data', (chunk: Buffer) => {
          if (truncated) return
          bytes += chunk.length
          if (bytes > opts.maxBytes) {
            truncated = true
            const keep = Math.max(0, chunk.length - (bytes - opts.maxBytes))
            if (keep > 0) chunks.push(chunk.subarray(0, keep))
            res.destroy()
            return
          }
          chunks.push(chunk)
        })
        const finish = () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks),
            truncated,
          })
        res.on('end', finish)
        res.on('close', finish)
        res.on('error', () => finish())
      },
    )
    req.on('error', (err: Error) => {
      clearTimeout(timer)
      const aborted = err.name === 'AbortError'
      reject(new WebError(aborted ? 'timeout' : 'network', aborted ? 'request timed out' : err.message))
    })
    req.on('close', () => clearTimeout(timer))
    req.end()
  })
}

/** Fetch a URL as text, refusing non-public targets and cross-origin redirects. */
export async function fetchText(raw: string, opts: FetchTextOptions): Promise<FetchedText> {
  let url = normalizeUrl(raw)
  const maxRedirects = opts.maxRedirects ?? 3
  let bytes = 0
  let truncated = false

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const pinned = await resolvePublic(url.hostname)
    const res = await once(url, opts, pinned)
    bytes += res.body.length
    truncated ||= res.truncated

    const location = res.headers.location
    if (res.status >= 300 && res.status < 400 && typeof location === 'string' && location) {
      const next = new URL(location, url)
      if (next.hostname !== url.hostname) {
        // Tell the caller where it went instead of chasing it (avoids being
        // bounced to an internal host, and mirrors what Claude Code does).
        return {
          status: res.status,
          finalUrl: url.href,
          contentType: 'text/plain',
          text: `Redirected to a different host: ${next.href}`,
          bytes,
          truncated,
          redirectTo: next.href,
        }
      }
      url = next
      if (next.protocol === 'http:') url.protocol = 'https:'
      continue
    }

    const contentType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim()
    if (contentType && !TEXTUAL.test(contentType)) {
      throw new WebError('unsupported-content-type', `refusing ${contentType} from ${url.href}`)
    }
    const text = res.body.toString('utf8')
    return {
      status: res.status,
      finalUrl: url.href,
      contentType: contentType || 'text/plain',
      text: text.slice(0, opts.maxChars),
      bytes,
      truncated: truncated || text.length > opts.maxChars,
    }
  }

  throw new WebError('redirect', `too many redirects fetching ${raw}`)
}
