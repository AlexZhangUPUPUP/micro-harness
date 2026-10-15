#!/usr/bin/env bun
/**
 * Standalone server entry point: `bun packages/server/src/main.ts`.
 *
 * Env:
 *   MICRO_PORT / MICRO_HOST       bind address (default 127.0.0.1:8787)
 *   MICRO_DATA_DIR                session + index directory (default ~/.micro-harness)
 *   MICRO_SERVER_TOKEN            bearer token (required beyond loopback)
 *   MICRO_MODEL / MICRO_BASE_URL / MICRO_API_KEY   model provider
 *   MICRO_MODELS                  comma-separated model list (defaults to MICRO_MODEL alone)
 *   MICRO_PRICE_INPUT / MICRO_PRICE_OUTPUT         USD per 1M tokens
 *   MICRO_PRICE_INPUT_CACHED                       USD per 1M cached input tokens
 *   MICRO_MAX_TOOL_OUTPUT                          cap on one tool result, in characters
 *   MICRO_APPROVAL                                 full-auto (default) | auto-edit | suggest
 */

import os from 'node:os'
import path from 'node:path'
import {
  connectMcpServers,
  loadAgentRoles,
  loadMcpServers,
  makeTools,
  mcpInfos,
  mcpTools,
  openaiProvider,
  type McpConnection,
} from '@micro-harness/core'
import { createServer } from './server.ts'
import { SessionStore } from './store.ts'

const port = Number(process.env.MICRO_PORT ?? 8787)
const hostname = process.env.MICRO_HOST ?? '127.0.0.1'
const dataDir = path.resolve(process.env.MICRO_DATA_DIR ?? path.join(os.homedir(), '.micro-harness'))
const model = process.env.MICRO_MODEL ?? 'deepseek-chat'
const models = (process.env.MICRO_MODELS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const baseUrl = process.env.MICRO_BASE_URL ?? 'https://api.deepseek.com'
const apiKey = process.env.MICRO_API_KEY ?? ''
const token = process.env.MICRO_SERVER_TOKEN

if (!apiKey) console.error('warning: MICRO_API_KEY is not set — model calls will fail')

const agentsDir = process.env.MICRO_AGENTS_DIR
const roles = agentsDir ? loadAgentRoles(path.resolve(agentsDir)) : []

// MCP: read the config once at boot, connect, merge the tools. Nothing below this
// line knows MCP exists — they are just more `Tool`s. A failing server is reported
// and skipped instead of taking the server down.
const mcpConfig = loadMcpServers(process.cwd())
const mcpConns: McpConnection[] = mcpConfig.servers.length
  ? await connectMcpServers(mcpConfig.servers, { cwd: process.cwd() })
  : []
const mcpServers = mcpInfos(mcpConns)
if (mcpServers.length) {
  console.log(`mcp · ${mcpServers.length} server(s) from ${mcpConfig.path}`)
  for (const info of mcpServers) {
    console.log(
      info.status === 'ready'
        ? `  ✓ ${info.name} (${info.transport}) → ${info.tools.length} tool(s)`
        : `  ✗ ${info.name}: ${info.error}`,
    )
  }
}

const store = new SessionStore(dataDir)
const provider = openaiProvider({ baseUrl, apiKey })
const server = createServer({
  store,
  provider,
  tools: [...makeTools(), ...mcpTools(mcpConns)],
  mcpServers,
  model,
  models,
  cwd: process.cwd(),
  hostname,
  port,
  token,
  roles,
  allowBash: process.env.MICRO_ALLOW_BASH === '1',
  isolation: process.env.MICRO_ISOLATE === '1' ? 'worktree' : 'none',
  approval: (['suggest', 'auto-edit', 'full-auto'].includes(process.env.MICRO_APPROVAL ?? '')
    ? process.env.MICRO_APPROVAL
    : 'full-auto') as 'suggest' | 'auto-edit' | 'full-auto',
  pricing: {
    input: Number(process.env.MICRO_PRICE_INPUT ?? 0),
    output: Number(process.env.MICRO_PRICE_OUTPUT ?? 0),
    inputCached: Number(process.env.MICRO_PRICE_INPUT_CACHED ?? 0),
  },
  maxToolOutput: Number(process.env.MICRO_MAX_TOOL_OUTPUT ?? 0) || undefined,
})

console.log(`micro-harness server · ${server.url} · data ${dataDir}${token ? ' · auth on' : ''}`)

const shutdown = (): void => {
  console.log('\nshutting down…')
  server.stop(true)
  void Promise.all(mcpConns.map((c) => c.close())).finally(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
