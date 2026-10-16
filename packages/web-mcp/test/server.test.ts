import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHandler } from '../src/server.ts'
import { buildTools, type ToolDef } from '../src/tools.ts'
import { loadWebConfig } from '../src/config.ts'

const fakeTools: ToolDef[] = [
  {
    name: 'echo',
    description: 'echo back',
    inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
    run: async (args) => ({ text: `echo:${String(args.msg ?? '')}` }),
  },
  {
    name: 'boom',
    description: 'throws',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      throw new Error('kaboom')
    },
  },
]

const handle = createHandler(fakeTools)

test('initialize returns protocol version and tool capability', async () => {
  const res = (await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })) as any
  expect(res.result.protocolVersion).toBe('2025-06-18')
  expect(res.result.capabilities.tools).toEqual({})
  expect(res.result.serverInfo.name).toBe('micro-harness-web')
})

test('notifications get no reply', async () => {
  expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
})

test('tools/list advertises name, description and inputSchema', async () => {
  const res = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })) as any
  expect(res.result.tools.map((t: any) => t.name)).toEqual(['echo', 'boom'])
  expect(res.result.tools[0].inputSchema.required).toEqual(['msg'])
})

test('tools/call returns MCP text content, and isError for a thrown tool', async () => {
  const ok = (await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'hi' } } })) as any
  expect(ok.result.content).toEqual([{ type: 'text', text: 'echo:hi' }])
  expect(ok.result.isError).toBe(false)

  const bad = (await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } })) as any
  expect(bad.result.isError).toBe(true)

  const missing = (await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } })) as any
  expect(missing.error.code).toBe(-32602)
})

test('unknown methods are rejected with -32601', async () => {
  const res = (await handle({ jsonrpc: '2.0', id: 6, method: 'resources/list', params: {} })) as any
  expect(res.error.code).toBe(-32601)
})

test('MICRO_WEB gates which tools exist', () => {
  const names = (env: Record<string, string>) => buildTools(loadWebConfig(env as NodeJS.ProcessEnv)).map((t) => t.name)
  expect(names({ MICRO_WEB: 'off' })).toEqual([])
  expect(names({ MICRO_WEB: 'fetch' })).toEqual(['web_fetch'])
  expect(names({ MICRO_WEB: 'search' })).toEqual(['web_search'])
  expect(names({ MICRO_WEB: 'all' })).toEqual(['web_fetch', 'web_search'])
})

test('the runtime toggle refuses a call without touching the network', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'web-off-'))
  const file = path.join(dir, 'web.json')
  writeFileSync(file, JSON.stringify({ enabled: false }))
  try {
    const [fetchTool] = buildTools(loadWebConfig({ MICRO_WEB: 'fetch', MICRO_WEB_TOGGLE_FILE: file } as NodeJS.ProcessEnv))
    const res = await fetchTool!.run({ url: 'https://example.com' })
    expect(res.isError).toBe(true)
    expect(res.text).toMatch(/disabled/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
