import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadWebConfig, capabilities, runtimeEnabled, runtimeSettings } from '../src/web/config.ts'

test('defaults: mode all, provider bing, no keys', () => {
  const cfg = loadWebConfig({} as NodeJS.ProcessEnv, '/home/x')
  expect(cfg.mode).toBe('all')
  expect(cfg.provider).toBe('bing')
  expect(cfg.toggleFile).toBe('/home/x/.micro-harness/web.json')
  expect(cfg.bochaKey).toBe('')
})

test('unknown modes fall back to all rather than silently disabling', () => {
  expect(loadWebConfig({ MICRO_WEB: 'nonsense' } as NodeJS.ProcessEnv).mode).toBe('all')
  expect(loadWebConfig({ MICRO_WEB: 'OFF' } as NodeJS.ProcessEnv).mode).toBe('off')
})

test('capabilities map the mode to the tools', () => {
  expect(capabilities('off')).toEqual({ fetch: false, search: false })
  expect(capabilities('fetch')).toEqual({ fetch: true, search: false })
  expect(capabilities('search')).toEqual({ fetch: false, search: true })
  expect(capabilities('all')).toEqual({ fetch: true, search: true })
})

test('the runtime toggle only disables on an explicit enabled:false', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'web-toggle-'))
  const file = path.join(dir, 'web.json')
  try {
    expect(runtimeEnabled(file)).toBe(true) // missing = enabled
    writeFileSync(file, JSON.stringify({ enabled: true }))
    expect(runtimeEnabled(file)).toBe(true)
    writeFileSync(file, JSON.stringify({ enabled: false }))
    expect(runtimeEnabled(file)).toBe(false)
    writeFileSync(file, '{ not json')
    expect(runtimeEnabled(file)).toBe(true) // corrupt = enabled
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the runtime file can also pick the search provider', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'web-provider-'))
  const file = path.join(dir, 'web.json')
  try {
    expect(runtimeSettings(file)).toEqual({ enabled: true }) // missing = boot provider
    writeFileSync(file, JSON.stringify({ enabled: false, provider: ' Bocha ' }))
    expect(runtimeSettings(file)).toEqual({ enabled: false, provider: 'bocha' })
    writeFileSync(file, JSON.stringify({ provider: 42 }))
    expect(runtimeSettings(file)).toEqual({ enabled: true }) // non-string ignored
    writeFileSync(file, '{ not json')
    expect(runtimeSettings(file)).toEqual({ enabled: true }) // corrupt = defaults
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
