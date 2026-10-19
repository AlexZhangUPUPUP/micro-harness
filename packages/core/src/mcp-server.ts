/**
 * Serve micro-harness's tools over MCP (stdio, newline-delimited JSON-RPC 2.0).
 *
 * This is the mirror image of `packages/core/src/mcp.ts`: that file *consumes*
 * MCP servers, this one *is* one. Together with the ACP server it makes the
 * harness usable from both directions — an editor can drive it, and another
 * agent can call its tools.
 *
 * Nothing here touches the model: the tools run against the working directory,
 * with the same `Tool` implementations the agent loop uses.
 */

import { dispatch, type Tool, type ToolContext } from './tools.ts'

export const MCP_PROTOCOL_VERSION = '2025-06-18'

interface Frame {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

export interface McpServeOptions {
  tools: Tool[]
  ctx: ToolContext
  serverInfo?: { name: string; version: string }
}

/** One JSON-RPC frame in, one reply out (or null for notifications). */
export function createMcpHandler(opts: McpServeOptions) {
  const byName = new Map(opts.tools.map((t) => [t.name, t]))
  const info = opts.serverInfo ?? { name: 'micro-harness', version: '0.1.0' }

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
        return reply({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: info })
      case 'notifications/initialized':
        return null
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({
          tools: opts.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })),
        })
      case 'tools/call': {
        const name = String(frame.params?.name ?? '')
        const args = (frame.params?.arguments as Record<string, unknown> | undefined) ?? {}
        if (!byName.has(name)) return fail(-32602, `unknown tool: ${name}`)
        const result = await dispatch(opts.tools, name, JSON.stringify(args), opts.ctx)
        return reply({ content: [{ type: 'text', text: result.output }], isError: result.isError === true })
      }
      default:
        return frame.id === undefined ? null : fail(-32601, `method not found: ${frame.method}`)
    }
  }
}

/** Serve until stdin closes. Everything that is not a protocol frame goes to stderr. */
export async function runMcpServer(opts: McpServeOptions, stdin: AsyncIterable<Uint8Array> = process.stdin): Promise<void> {
  const handle = createMcpHandler(opts)
  let buffer = ''
  for await (const chunk of stdin) {
    buffer += Buffer.from(chunk).toString('utf8')
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
      if (!line) continue
      let frame: Frame
      try {
        frame = JSON.parse(line) as Frame
      } catch {
        continue
      }
      const reply = await handle(frame)
      if (reply) process.stdout.write(JSON.stringify(reply) + '\n')
    }
  }
}
