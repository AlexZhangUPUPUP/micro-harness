import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectMcpServer, connectMcpServers, loadMcpServers, mcpToolName, mcpTools, parseMcpConfig } from '../src/mcp.ts'
import { dispatch, makeTools } from '../src/tools.ts'

const mockServer = fileURLToPath(new URL('./fixtures/mcp-mock-server.mjs', import.meta.url))
const stdioConfig = { name: 'mock', command: process.execPath, args: [mockServer] }

test('stdio: initialize, list tools, call them, and namespace the names', async () => {
  const conn = await connectMcpServer(stdioConfig, { timeoutMs: 10_000 })
  expect(conn.info.status).toBe('ready')
  expect(conn.info.transport).toBe('stdio')
  expect(conn.info.tools).toEqual(['mock__echo', 'mock__boom', 'mock__peek'])
  expect(conn.tools.map((t) => t.name)).toEqual(['mock__echo', 'mock__boom', 'mock__peek'])

  const echo = conn.tools.find((t) => t.name === 'mock__echo')!
  expect(echo.description).toBe('Echo the text back')
  expect(echo.mutating).toBe(true) // undeclared → assume it can write
  expect(conn.tools.find((t) => t.name === 'mock__peek')!.mutating).toBe(false) // readOnlyHint
  expect(echo.parameters).toMatchObject({ type: 'object' })

  const ok = await echo.run({ text: 'hi' }, { cwd: '.', allowBash: false })
  expect(ok.output).toBe('echo:hi')
  expect(ok.isError).toBeFalsy()

  // a server-side tool failure is data, not an exception
  const boom = await conn.tools.find((t) => t.name === 'mock__boom')!
  const failed = await boom.run({}, { cwd: '.', allowBash: false })
  expect(failed.isError).toBe(true)
  expect(failed.output).toContain('kaboom')

  await conn.close()
})

test('an MCP tool behaves like any other tool through dispatch', async () => {
  const conn = await connectMcpServer(stdioConfig, { timeoutMs: 10_000 })
  const tools = [...makeTools(), ...conn.tools]
  const ctx = { cwd: '.', allowBash: false }

  const res = await dispatch(tools, 'mock__echo', JSON.stringify({ text: 'through the loop' }), ctx)
  expect(res.isError).toBeFalsy()
  expect(res.output).toBe('echo:through the loop')

  // an unknown MCP tool surfaces the server's error message
  const missing = await dispatch(tools, 'mock__nope', '{}', ctx)
  expect(missing.isError).toBe(true)
  expect(missing.output).toContain('unknown tool')

  await conn.close()
})

test('a server that cannot start is reported, not thrown', async () => {
  const conn = await connectMcpServer({ name: 'broken', command: 'definitely-not-a-real-binary-xyz' }, { timeoutMs: 5000 })
  expect(conn.info.status).toBe('error')
  expect(conn.info.error).toMatch(/failed to start|exited/)
  expect(conn.tools).toEqual([])
  await conn.close()
})

test('several servers connect together; a broken one does not take the others down', async () => {
  const conns = await connectMcpServers([stdioConfig, { name: 'broken', command: 'nope-not-here' }], { timeoutMs: 8000 })
  expect(conns.map((c) => c.info.status)).toEqual(['ready', 'error'])
  expect(mcpTools(conns).map((t) => t.name)).toEqual(['mock__echo', 'mock__boom', 'mock__peek'])
  await Promise.all(conns.map((c) => c.close()))
})

test('http: the same protocol over streamable HTTP, including an SSE reply', async () => {
  const sse = process.env.MCP_TEST_SSE === '1'
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id?: number; method?: string; params?: Record<string, unknown> }
      const reply = (result: unknown): Response => {
        const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result })
        if (sse) {
          return new Response(`event: message\ndata: ${payload}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          })
        }
        return Response.json({ jsonrpc: '2.0', id: body.id, result })
      }
      if (body.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} } })
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (body.method === 'tools/list') {
        return reply({ tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }] })
      }
      if (body.method === 'tools/call') return reply({ content: [{ type: 'text', text: 'pong' }] })
      return new Response(null, { status: 202 })
    },
  })

  try {
    const conn = await connectMcpServer({ name: 'http', url: `http://127.0.0.1:${server.port}/mcp` }, { timeoutMs: 8000 })
    expect(conn.info.status).toBe('ready')
    expect(conn.info.transport).toBe('http')
    expect(conn.tools.map((t) => t.name)).toEqual(['http__ping'])
    const res = await conn.tools[0]!.run({}, { cwd: '.', allowBash: false })
    expect(res.output).toBe('pong')
    await conn.close()
  } finally {
    server.stop(true)
  }
})

test('the SSE branch of the HTTP transport', async () => {
  process.env.MCP_TEST_SSE = '1'
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id?: number; method?: string }
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result:
          body.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
            : body.method === 'tools/list'
              ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
              : { content: [{ type: 'text', text: 'pong' }] },
      })
      return new Response(`event: message\ndata: ${payload}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    const conn = await connectMcpServer({ name: 'sse', url: `http://127.0.0.1:${server.port}/mcp` }, { timeoutMs: 8000 })
    expect(conn.info.status).toBe('ready')
    expect((await conn.tools[0]!.run({}, { cwd: '.', allowBash: false })).output).toBe('pong')
    await conn.close()
  } finally {
    delete process.env.MCP_TEST_SSE
    server.stop(true)
  }
})

test('config: parses the Claude/Cursor shape and finds the standard paths', () => {
  const servers = parseMcpConfig('{"mcpServers":{"fs":{"command":"npx","args":["-y","x"]},"web":{"url":"https://x/mcp"}}}')
  expect(servers).toEqual([
    { name: 'fs', command: 'npx', args: ['-y', 'x'] },
    { name: 'web', url: 'https://x/mcp' },
  ])
  expect(() => parseMcpConfig('{oops')).toThrow(/invalid MCP config/)

  const dir = mkdtempSync(path.join(tmpdir(), 'mh-mcp-'))
  expect(loadMcpServers(dir, { HOME: dir } as NodeJS.ProcessEnv).servers).toEqual([])

  const file = path.join(dir, 'mcp.json')
  writeFileSync(file, '{"mcpServers":{"one":{"command":"echo"}}}')
  const loaded = loadMcpServers(dir, { HOME: dir, MICRO_MCP_CONFIG: file } as NodeJS.ProcessEnv)
  expect(loaded.path).toBe(file)
  expect(loaded.servers).toEqual([{ name: 'one', command: 'echo' }])
})

test('tool names are namespaced and sanitized', () => {
  expect(mcpToolName('mock', 'echo')).toBe('mock__echo')
  expect(mcpToolName('my server/v2', 'read.file')).toBe('my_server_v2__read_file')
})
