import { test, expect } from 'bun:test'
import { createContext } from '@micro-harness/kernel'
import { corePlugin, type ProviderRegistry } from '../src/plugin.ts'
import type { Tool } from '../src/tools.ts'
import type { Provider } from '../src/provider.ts'

const fakeProvider: Provider = { name: 'fake', async chat() { return { message: { role: 'assistant', content: 'ok' } } } }

test('the core plugin provides tools and a provider registry', () => {
  const ctx = createContext('test')
  ctx.plugin(corePlugin, { providers: { fake: fakeProvider } })

  const tools = ctx.get<Tool[]>('tools')
  expect(Array.isArray(tools)).toBe(true)
  expect(tools.map((t) => t.name)).toContain('write_file')

  const providers = ctx.get<ProviderRegistry>('providers')
  expect(providers.list()).toEqual(['fake'])
  expect(providers.has('fake')).toBe(true)
  expect(providers.get('fake')).toBe(fakeProvider)
  expect(() => providers.get('nope')).toThrow()
})

test('core mounts after kernel and can be unmounted cleanly', () => {
  const ctx = createContext('test')
  const unload = ctx.plugin(corePlugin, {})
  expect(ctx.has('tools')).toBe(true)
  unload.dispose()
  expect(ctx.has('tools')).toBe(false)
})
