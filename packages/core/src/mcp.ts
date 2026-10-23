/**
 * MCP client — the Model Context Protocol, as a **capability seam**.
 *
 * The design decision here is deliberate and small: an MCP server is *read from
 * config at boot, connected, its tools merged into the registry, and closed on
 * exit*. That is a constructor, not a container — see docs/design-comparison.md
 * ("seams, not a container") for why. Nothing in this file knows about the loop.
 *
 * Implemented without the official SDK: the part we need (initialize → tools/list →
 * tools/call over stdio or streamable HTTP) is a few hundred lines of JSON-RPC, and
 * keeping the repo dependency-free is worth more than the convenience.
 *
 * Transports:
 *   - **stdio**  spawn a child, newline-delimited JSON-RPC on its stdin/stdout
 *   - **http**   POST JSON-RPC; the reply is JSON or a one-shot SSE stream
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Tool, ToolContext, ToolResult } from './tools.ts'

/** The protocol revision we advertise; servers may answer with their own. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

export interface McpServerConfig {
  /** Local name; also the namespace its tools are exposed under. */
  name?: string
  /** stdio transport: the command to spawn. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** streamable-HTTP transport: the endpoint. */
  url?: string
  headers?: Record<string, string>
  /**
   * Mark every tool from this server as a network capability. The permission
   * presets use it to keep `read-only`/`workspace` offline, and `auto-review`
   * asks before each call.
   */
  network?: boolean
}

/** One server from `mcpServers` in the config file. */
export interface McpConfigFile {
  mcpServers?: Record<string, Omit<McpServerConfig, 'name'>>
}

export interface McpServerInfo {
  name: string
  transport: 'stdio' | 'http'
  status: 'ready' | 'error'
  tools: string[]
  error?: string
}

export interface McpConnection {
  info: McpServerInfo
  tools: Tool[]
  close(): Promise<void>
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
  method?: string
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_')

/** `server__tool` — namespaced so two servers can both expose `search`. */
export const mcpToolName = (server: string, tool: string): string => `${sanitize(server)}__${sanitize(tool)}`

interface McpToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  /**
   * MCP's own safety hints. `readOnlyHint` is the one the permission model can
   * trust: a read-only session may use such a tool instead of losing every tool
   * from the server.
   */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

/** Whatever the transport is, this is all the client needs from it. */
interface JsonRpcChannel {
  request<T>(method: string, params?: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T>
  notify(method: string, params?: unknown): void
  close(): void
}

/* --------------------------------------------------------------- stdio */

function stdioChannel(command: string, args: string[], env: Record<string, string> = {}, cwd?: string): JsonRpcChannel {
  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    cwd,
  })
  let nextId = 0
  let buffer = ''
  let stderr = ''
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let closed = false

  const fail = (err: Error): void => {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  const handle = (msg: JsonRpcResponse): void => {
    // A server-initiated request (has both id and method): answer "not supported"
    // rather than letting the server wait forever.
    if (msg.id !== undefined && msg.method) {
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } }) + '\n',
      )
      return
    }
    if (msg.id === undefined) return // notification — nothing to do
    const p = pending.get(Number(msg.id))
    if (!p) return
    pending.delete(Number(msg.id))
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(`${msg.error.message ?? 'mcp error'}${msg.error.code ? ` (${msg.error.code})` : ''}`))
    else p.resolve(msg.result)
  }

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line) {
        try {
          handle(JSON.parse(line) as JsonRpcResponse)
        } catch {
          /* not JSON-RPC (banner/logs on stdout) — ignore */
        }
      }
      nl = buffer.indexOf('\n')
    }
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-4000)
  })
  child.on('error', (err) => fail(new Error(`failed to start ${command}: ${err.message}`)))
  child.on('exit', (code) => fail(new Error(`${command} exited${code === null ? '' : ` with ${code}`}${stderr ? `: ${stderr.trim().slice(-400)}` : ''}`)))

  return {
    request<T>(method: string, params?: unknown, timeoutMs = 15_000, signal?: AbortSignal): Promise<T> {
      if (closed) return Promise.reject(new Error('mcp channel is closed'))
      if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('mcp request aborted'))
      const id = ++nextId
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          if (signal && onAbort) signal.removeEventListener('abort', onAbort)
          reject(new Error(`mcp ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        const onAbort = (): void => {
          if (!pending.has(id)) return
          pending.delete(id)
          clearTimeout(timer)
          reject(signal?.reason ?? new Error('mcp request aborted'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
        try {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params } satisfies JsonRpcRequest) + '\n')
        } catch (err) {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          pending.delete(id)
          reject(err as Error)
        }
      })
    },
    notify(method: string, params?: unknown): void {
      if (closed) return
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
      } catch {
        /* the pipe is gone */
      }
    },
    close(): void {
      closed = true
      fail(new Error('mcp channel closed'))
      try {
        child.stdin.end()
        child.kill()
      } catch {
        /* already gone */
      }
    },
  }
}

/* ---------------------------------------------------------------- http */

function httpChannel(url: string, headers: Record<string, string> = {}): JsonRpcChannel {
  let nextId = 0
  let sessionId: string | undefined
  let closed = false

  const send = async (body: unknown): Promise<JsonRpcResponse> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    })
    const sid = res.headers.get('mcp-session-id')
    if (sid) sessionId = sid
    if (!res.ok) throw new Error(`mcp http ${res.status} ${res.statusText}`)
    const type = res.headers.get('content-type') ?? ''
    if (type.includes('text/event-stream')) {
      // one-shot SSE: read frames until we find the reply to our id
      const text = await res.text()
      for (const frame of text.split('\n\n')) {
        const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
        if (!data) continue
        try {
          const msg = JSON.parse(data) as JsonRpcResponse
          if (msg.id !== undefined || msg.error) return msg
        } catch {
          /* keep scanning */
        }
      }
      throw new Error('mcp http: no JSON-RPC reply in the event stream')
    }
    return (await res.json()) as JsonRpcResponse
  }

  return {
    async request<T>(method: string, params?: unknown, timeoutMs = 15_000, signal?: AbortSignal): Promise<T> {
      if (closed) throw new Error('mcp channel is closed')
      if (signal?.aborted) throw signal.reason ?? new Error('mcp request aborted')
      const id = ++nextId
      const call = send({ jsonrpc: '2.0', id, method, params })
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`mcp ${method} timed out after ${timeoutMs}ms`)), timeoutMs),
      )
      const aborted = signal
        ? new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason ?? new Error('mcp request aborted')), { once: true }))
        : undefined
      const msg = await Promise.race(aborted ? [call, timeout, aborted] : [call, timeout])
      if (msg.error) throw new Error(msg.error.message ?? 'mcp error')
      return msg.result as T
    },
    notify(method: string, params?: unknown): void {
      if (closed) return
      void send({ jsonrpc: '2.0', method, params }).catch(() => undefined)
    },
    close(): void {
      closed = true
    },
  }
}

/* ------------------------------------------------------------- client */

const textOf = (result: unknown): string => {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) return JSON.stringify(result ?? '')
  return content
    .map((part) => {
      const p = part as { type?: string; text?: string; data?: string; mimeType?: string }
      if (p.type === 'text') return p.text ?? ''
      if (p.type === 'image') return `[image ${p.mimeType ?? ''}]`
      if (p.type === 'resource') return `[resource]`
      return JSON.stringify(part)
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Connect one server: initialize → initialized → tools/list, and wrap every tool
 * as a normal `Tool` so the loop cannot tell the difference.
 */
export async function connectMcpServer(
  config: McpServerConfig,
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<McpConnection> {
  const timeout = opts.timeoutMs ?? 15_000
  const transport: 'stdio' | 'http' = config.url ? 'http' : 'stdio'
  const name = config.name || (config.url ? new URL(config.url).host : String(config.command ?? 'mcp'))

  const channel =
    transport === 'http'
      ? httpChannel(config.url!, config.headers)
      : stdioChannel(String(config.command ?? ''), config.args ?? [], config.env, opts.cwd)

  try {
    await channel.request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: { name: 'micro-harness', version: '0.1.0' },
      },
      timeout,
    )
    channel.notify('notifications/initialized')

    const defs: McpToolDef[] = []
    let cursor: string | undefined
    do {
      const page = await channel.request<{ tools?: McpToolDef[]; nextCursor?: string }>(
        'tools/list',
        cursor ? { cursor } : {},
        timeout,
      )
      defs.push(...(page.tools ?? []))
      cursor = page.nextCursor
    } while (cursor)

    const tools: Tool[] = defs.map((def) => ({
      name: mcpToolName(name, def.name),
      description: def.description ?? `MCP tool ${def.name} from ${name}`,
      parameters: (def.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      mutating: def.annotations?.readOnlyHint !== true, // undeclared = assume it can write
      network: config.network === true,
      async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
        const result = await channel.request<{ content?: unknown; isError?: boolean }>(
          'tools/call',
          { name: def.name, arguments: args },
          60_000,
          ctx.signal,
        )
        return { output: textOf(result), isError: result?.isError === true }
      },
    }))

    return {
      info: { name, transport, status: 'ready', tools: tools.map((t) => t.name) },
      tools,
      close: async () => channel.close(),
    }
  } catch (err) {
    channel.close()
    const message = (err as Error)?.message ?? String(err)
    return {
      info: { name, transport, status: 'error', tools: [], error: message },
      tools: [],
      close: async () => undefined,
    }
  }
}

/** Connect every configured server. A failing server is reported, not fatal. */
export async function connectMcpServers(
  configs: McpServerConfig[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<McpConnection[]> {
  return Promise.all(configs.map((c) => connectMcpServer(c, opts)))
}

/** Flatten connections into one tool list, skipping errored servers. */
export function mcpTools(connections: McpConnection[]): Tool[] {
  return connections.flatMap((c) => c.tools)
}

export function mcpInfos(connections: McpConnection[]): McpServerInfo[] {
  return connections.map((c) => c.info)
}

/* --------------------------------------------------------------- config */

/**
 * Read `mcpServers` from a JSON file. The shape matches the one Claude Code and
 * Cursor use, so existing config files work unchanged:
 *
 * ```json
 * { "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } } }
 * ```
 */
export function parseMcpConfig(text: string): McpServerConfig[] {
  let parsed: McpConfigFile
  try {
    parsed = JSON.parse(text) as McpConfigFile
  } catch (err) {
    throw new Error(`invalid MCP config: ${(err as Error).message}`)
  }
  return Object.entries(parsed.mcpServers ?? {}).map(([name, cfg]) => ({ name, ...cfg }))
}

/** Where we look for a config file, in order. */
export function mcpConfigCandidates(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? ''
  return [
    ...(env.MICRO_MCP_CONFIG ? [env.MICRO_MCP_CONFIG] : []),
    path.join(cwd, '.micro-harness', 'mcp.json'),
    path.join(cwd, '.mcp.json'),
    path.join(home, '.micro-harness', 'mcp.json'),
  ].filter(Boolean)
}

/** The first existing config file, or null. */
export function findMcpConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of mcpConfigCandidates(cwd, env)) {
    try {
      if (readFileSync(candidate, 'utf8').trim()) return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

/** Load a config file, or return [] when none of the standard paths exist. */
export function loadMcpServers(cwd: string, env: NodeJS.ProcessEnv = process.env): { path: string | null; servers: McpServerConfig[] } {
  const found = findMcpConfig(cwd, env)
  if (!found) return { path: null, servers: [] }
  return { path: found, servers: parseMcpConfig(readFileSync(found, 'utf8')) }
}
