#!/usr/bin/env bun
/**
 * The stdio side of the web MCP server.
 *
 * Newline-delimited JSON-RPC 2.0, no SDK — the mirror image of micro-harness's
 * own MCP client (`packages/core/src/mcp.ts`), which speaks exactly
 * initialize → notifications/initialized → tools/list → tools/call.
 *
 * Config comes from the environment (see `loadWebConfig`). Everything that is
 * not a protocol frame goes to stderr, never stdout.
 */

import { loadWebConfig, capabilities, runtimeEnabled } from './config.ts'
import { buildTools, type ToolDef } from './tools.ts'

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'micro-harness-web', version: '0.1.0' }

interface Frame {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

export function createHandler(tools: ToolDef[], log: (msg: string) => void = () => {}) {
  const byName = new Map(tools.map((t) => [t.name, t]))

  return async function handle(frame: Frame): Promise<Record<string, unknown> | null> {
    const id = frame.id ?? null
    const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result })
    const fail = (code: number, message: string): Record<string, unknown> => ({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    })

    // A notification (no id) never gets a reply.
    if (frame.id === undefined && frame.method?.startsWith('notifications/')) return null

    switch (frame.method) {
      case 'initialize':
        return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO })
      case 'notifications/initialized':
        return null
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({
          tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        })
      case 'tools/call': {
        const name = String(frame.params?.name ?? '')
        const args = (frame.params?.arguments as Record<string, unknown> | undefined) ?? {}
        const tool = byName.get(name)
        if (!tool) return fail(-32602, `unknown tool: ${name}`)
        try {
          const { text, isError } = await tool.run(args)
          return reply({ content: [{ type: 'text', text }], isError: isError === true })
        } catch (err) {
          log(`tool ${name} threw: ${String((err as Error)?.message ?? err)}`)
          return reply({
            content: [{ type: 'text', text: `internal error running ${name}` }],
            isError: true,
          })
        }
      }
      default:
        return fail(-32601, `unsupported method: ${frame.method ?? '(none)'}`)
    }
  }
}

if (import.meta.main) {
  const cfg = loadWebConfig()
  const caps = capabilities(cfg.mode)
  const tools = buildTools(cfg)
  const handle = createHandler(tools, (m) => process.stderr.write(`[web-mcp] ${m}\n`))

  process.stderr.write(
    `[web-mcp] mode=${cfg.mode} provider=${cfg.provider} enabled=${runtimeEnabled(cfg.toggleFile)} ` +
      `tools=[${tools.map((t) => t.name).join(', ') || 'none'}]` +
      (caps.fetch || caps.search ? '' : ' (MICRO_WEB=off — nothing to serve)\n'),
  )

  let buffer = ''
  const write = (obj: unknown): void => {
    process.stdout.write(JSON.stringify(obj) + '\n')
  }

  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const nl = buffer.indexOf('\n')
      if (nl === -1) break
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let frame: Frame
      try {
        frame = JSON.parse(line) as Frame
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
        continue
      }
      void handle(frame)
        .then((reply) => {
          if (reply) write(reply)
        })
        .catch((err: unknown) => {
          process.stderr.write(`[web-mcp] handler crashed: ${String((err as Error)?.message ?? err)}\n`)
        })
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
