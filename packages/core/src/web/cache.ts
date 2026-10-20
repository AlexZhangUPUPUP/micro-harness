/**
 * A tiny in-process cache for `web_fetch`.
 *
 * Models re-fetch the same page (a listing they already read, a page they
 * truncated with a smaller `maxChars`) and every miss is a network round-trip
 * plus another copy of the text in the context window. The cache is keyed by
 * URL *and* the caps, so a small request never poisons a large one, and it is
 * bounded so a long session cannot grow without limit.
 */

export interface CachedPage {
  text: string
  finalUrl: string
  status: number
  contentType: string
  bytes: number
  truncated: boolean
}

export const CACHE_TTL_MS = 5 * 60_000
export const CACHE_LIMIT = 32

const entries = new Map<string, { at: number; page: CachedPage }>()

export function cacheKey(url: string, maxChars: number, maxBytes: number): string {
  return `${url}\u0000${maxChars}\u0000${maxBytes}`
}

export function cacheGet(key: string, now = Date.now()): CachedPage | undefined {
  const hit = entries.get(key)
  if (!hit) return undefined
  if (now - hit.at > CACHE_TTL_MS) {
    entries.delete(key)
    return undefined
  }
  // Refresh recency: Map preserves insertion order, so delete + set is an LRU bump.
  entries.delete(key)
  entries.set(key, hit)
  return hit.page
}

export function cacheSet(key: string, page: CachedPage, now = Date.now()): void {
  entries.delete(key)
  entries.set(key, { at: now, page })
  while (entries.size > CACHE_LIMIT) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

export function cacheSize(): number {
  return entries.size
}

export function cacheClear(): void {
  entries.clear()
}
