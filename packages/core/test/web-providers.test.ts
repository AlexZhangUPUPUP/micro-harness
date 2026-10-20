import { test, expect } from 'bun:test'
import { parseBing, parseBaidu, parseDeepseek, pickProvider, resolveProvider, providerIds } from '../src/web/providers.ts'
import { loadWebConfig } from '../src/web/config.ts'

const BING = `<ol id="b_results"><li class="b_algo" data-id iid=SERP.1><h2><a href="https://www.deepseek.com/harness/" h="ID=SERP,1">DeepSeek Harness</a></h2><p class="b_lineclamp">The official harness.</p></li><li class="b_algo" data-id iid=SERP.2><h2><a href="https://github.com/deepseek-ai/deepseek-harness">GitHub - deepseek-ai/deepseek-harness</a></h2><p>Source &amp; docs.</p></li></ol>`

const BAIDU = `<div class="result c-container"><h3 class="t"><a href="https://www.baidu.com/link?url=abc" target="_blank">DeepSeek Harness 官网</a></h3></div>`

test('parseBing pulls title, url and snippet', () => {
  const r = parseBing(BING, 8)
  expect(r.length).toBe(2)
  expect(r[0]).toEqual({
    title: 'DeepSeek Harness',
    url: 'https://www.deepseek.com/harness/',
    snippet: 'The official harness.',
  })
  expect(r[1]!.url).toBe('https://github.com/deepseek-ai/deepseek-harness')
  expect(r[1]!.snippet).toBe('Source & docs.')
})

test('parseBing honours maxResults', () => {
  expect(parseBing(BING, 1).length).toBe(1)
})

test('parseBaidu pulls h3 anchors', () => {
  const r = parseBaidu(BAIDU, 8)
  expect(r.length).toBe(1)
  expect(r[0]!.title).toBe('DeepSeek Harness 官网')
  expect(r[0]!.url).toContain('baidu.com/link')
})

test('parseDeepseek prefers the model-sized summary and drops items without a url', () => {
  const r = parseDeepseek(
    {
      results: [
        { title: 'DeepSeek V4', url: 'https://example.com/v4', snippet: 'short', summary: 'long summary' },
        { title: 'no url', summary: 'x' },
      ],
    },
    8,
  )
  expect(r).toEqual([{ title: 'DeepSeek V4', url: 'https://example.com/v4', snippet: 'long summary' }])
})

test('resolveProvider rejects unknown and unconfigured providers', () => {
  const cfg = loadWebConfig({} as NodeJS.ProcessEnv)
  expect(providerIds()).toContain('bing')
  expect(providerIds()).toContain('bocha')
  expect(providerIds()).toContain('deepseek')
  expect(resolveProvider('bing', cfg).id).toBe('bing')
  expect(() => resolveProvider('nope', cfg)).toThrow(/unknown search provider/)
  expect(() => resolveProvider('bocha', cfg)).toThrow(/not configured/)
  expect(() => resolveProvider('deepseek', cfg)).toThrow(/not configured/)
})

test('pickProvider falls back to bing when the preferred engine is unconfigured', () => {
  const cfg = loadWebConfig({} as NodeJS.ProcessEnv)
  expect(pickProvider('bing', cfg)).toEqual({ id: 'bing', fallback: false })
  expect(pickProvider('bocha', cfg)).toEqual({ id: 'bing', fallback: true })
  const withKey = loadWebConfig({ BOCHA_API_KEY: 'k' } as NodeJS.ProcessEnv)
  expect(pickProvider('bocha', withKey)).toEqual({ id: 'bocha', fallback: false })
})
