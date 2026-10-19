import { test, expect } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MCP_PROTOCOL_VERSION, createMcpHandler } from '../src/mcp-server.ts'
import { makeTools } from '../src/tools.ts'

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

test('initialize, list and call tools through the handler', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-mcp-serve-'))
  try {
    writeFileSync(path.join(dir, 'a.txt'), 'hello from mcp')
    const handle = createMcpHandler({ tools: makeTools(), ctx: { cwd: dir, allowBash: false } })

    const init = (await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })) as {
      result: { protocolVersion: string; serverInfo: { name: string } }
    }
    expect(init.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION)
    expect(init.result.serverInfo.name).toBe('micro-harness')

    const list = (await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: { tools: Array<{ name: string; inputSchema: unknown }> }
    }
    expect(list.result.tools.map((t) => t.name)).toContain('read_file')
    expect(list.result.tools.find((t) => t.name === 'read_file')!.inputSchema).toMatchObject({ type: 'object' })

    const call = (await handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'a.txt' } },
    })) as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(call.result.isError).toBe(false)
    expect(call.result.content[0]!.text).toContain('hello from mcp')

    const unknown = (await handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    })) as { error: { code: number } }
    expect(unknown.error.code).toBe(-32602)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the CLI serves the same tools over stdio', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-mcp-cli-'))
  writeFileSync(path.join(dir, 'a.txt'), 'over the wire')
  const child = spawn(process.execPath, [cli, 'mcp', '--dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    const frames = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a.txt' } } },
    ]
    for (const frame of frames) child.stdin.write(JSON.stringify(frame) + '\n')

    const replies: Array<Record<string, unknown>> = []
    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('timed out waiting for MCP replies')), 10_000)
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        let nl = buffer.indexOf('\n')
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          nl = buffer.indexOf('\n')
          if (!line) continue
          replies.push(JSON.parse(line) as Record<string, unknown>)
          if (replies.length === 3) {
            clearTimeout(timer)
            resolve()
          }
        }
      })
      child.on('exit', () => {
        clearTimeout(timer)
        reject(new Error('mcp server exited early'))
      })
    })

    expect(replies[0]).toMatchObject({ id: 1 })
    expect(JSON.stringify(replies[1])).toContain('read_file')
    expect(JSON.stringify(replies[2])).toContain('over the wire')
    // bash stays off for an MCP client unless --allow-bash was passed
    expect(JSON.stringify(replies[1])).not.toContain('"bash"')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})
