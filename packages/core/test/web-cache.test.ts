import { beforeEach, expect, test } from 'bun:test'
import { CACHE_LIMIT, CACHE_TTL_MS, cacheClear, cacheGet, cacheKey, cacheSet, cacheSize } from '../src/web/cache.ts'

const page = (text: string) => ({
  text,
  finalUrl: 'https://example.com/',
  status: 200,
  contentType: 'text/html',
  bytes: text.length,
  truncated: false,
})

beforeEach(() => cacheClear())

test('the key separates the URL from the caps', () => {
  expect(cacheKey('https://example.com', 1000, 2)).not.toBe(cacheKey('https://example.com', 2000, 2))
  cacheSet(cacheKey('https://example.com', 1000, 2), page('small'))
  expect(cacheGet(cacheKey('https://example.com', 1000, 2))?.text).toBe('small')
  expect(cacheGet(cacheKey('https://example.com', 2000, 2))).toBeUndefined()
})

test('entries expire after the TTL', () => {
  const key = cacheKey('https://example.com', 1, 1)
  cacheSet(key, page('x'), 1_000)
  expect(cacheGet(key, 1_000 + CACHE_TTL_MS)?.text).toBe('x')
  expect(cacheGet(key, 1_001 + CACHE_TTL_MS)).toBeUndefined()
})

test('the cache is bounded and evicts the least recently used', () => {
  for (let i = 0; i < CACHE_LIMIT; i++) cacheSet(`k${i}`, page(String(i)))
  expect(cacheSize()).toBe(CACHE_LIMIT)
  cacheGet('k0') // bump
  cacheSet('new', page('new'))
  expect(cacheSize()).toBe(CACHE_LIMIT)
  expect(cacheGet('k1')).toBeUndefined()
  expect(cacheGet('k0')).toBeDefined()
})
