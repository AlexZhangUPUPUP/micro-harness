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
import { existsSync } from 'node:fs'
import {
  connectMcpServers,
  loadAgentRoles,
  loadMcpServers,
  makeTools,
  mcpInfos,
  mcpTools,
  openaiProvider,
  type McpConnection,
  type McpServerConfig,
} from '@micro-harness/core'
import { createServer, PERMISSIONS, type PermissionPreset } from './server.ts'
import { detectSandbox, type Sandbox, type SandboxMode } from '@micro-harness/core'
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

// Working directory for the agent's tools and MCP config. dev.sh/microh pass the
// folder you launched from, so `cd somewhere && microh` works there.
const cwd = process.env.MICRO_CWD ? path.resolve(process.env.MICRO_CWD) : process.cwd()

// Single-process mode: when the GUI is built, serve it from this same server so
// `bun packages/server/src/main.ts` (or `bun run ui`) is the whole app. Set
// MICRO_SERVE_GUI=0 for an API-only deployment, MICRO_GUI_DIR to point elsewhere.
const defaultGuiDir = path.resolve(import.meta.dir, '../../gui/dist')
const guiDir: string | false =
  process.env.MICRO_SERVE_GUI === '0'
    ? false
    : process.env.MICRO_GUI_DIR
      ? path.resolve(process.env.MICRO_GUI_DIR)
      : existsSync(path.join(defaultGuiDir, 'index.html'))
        ? defaultGuiDir
        : false

// MCP: read the config once at boot, connect, merge the tools. Nothing below this
// line knows MCP exists — they are just more `Tool`s. A failing server is reported
// and skipped instead of taking the server down.
const mcpConfig = loadMcpServers(cwd)

// First-party web tools. When MICRO_WEB is not `off`, connect our own MCP server
// (packages/web-mcp) unless the user already declared one named `web`.
const webEnv: Record<string, string> = {
  MICRO_WEB: process.env.MICRO_WEB ?? 'all',
  MICRO_SEARCH_PROVIDER: process.env.MICRO_SEARCH_PROVIDER ?? 'bing',
}
for (const key of ['MICRO_WEB_TOGGLE_FILE', 'MICRO_WEB_MAX_CHARS', 'MICRO_WEB_TIMEOUT_MS', 'BOCHA_API_KEY', 'DEEPSEEK_API_KEY', 'MICRO_SEARXNG_URL']) {
  const value = process.env[key]
  if (value) webEnv[key] = value
}
const webServerPath = path.resolve(import.meta.dir, '../../web-mcp/src/server.ts')
const webServer: McpServerConfig | null =
  (process.env.MICRO_WEB ?? 'all') !== 'off' && existsSync(webServerPath)
    ? { name: 'web', command: 'bun', args: [webServerPath], env: webEnv, network: true }
    : null

const serverConfigs = [
  ...(webServer ? [webServer] : []),
  ...mcpConfig.servers.filter((s) => s.name !== 'web'),
]
const mcpConns: McpConnection[] = serverConfigs.length
  ? await connectMcpServers(serverConfigs, { cwd })
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
const rawSandbox = (process.env.MICRO_SANDBOX ?? '').trim()
const sandboxMode: SandboxMode = rawSandbox === 'auto' || rawSandbox === 'require' ? rawSandbox : 'off'
let sandbox: Sandbox | null = null
try {
  const detected = detectSandbox(sandboxMode)
  sandbox = detected.sandbox
  if (detected.notice) console.error(`sandbox: ${detected.notice}`)
} catch (err) {
  console.error(String((err as Error)?.message ?? err))
  process.exit(1)
}

const server = createServer({
  store,
  provider,
  tools: [...makeTools(), ...mcpTools(mcpConns)],
  mcpServers,
  model,
  models,
  cwd,
  hostname,
  port,
  token,
  guiDir,
  permission:
    process.env.MICRO_PERMISSION && process.env.MICRO_PERMISSION in PERMISSIONS
      ? (process.env.MICRO_PERMISSION as PermissionPreset)
      : 'auto-review',
  roles,
  isolation: process.env.MICRO_ISOLATE === '1' ? 'worktree' : 'none',
  pricing: {
    input: Number(process.env.MICRO_PRICE_INPUT ?? 0),
    output: Number(process.env.MICRO_PRICE_OUTPUT ?? 0),
    inputCached: Number(process.env.MICRO_PRICE_INPUT_CACHED ?? 0),
  },
  maxToolOutput: Number(process.env.MICRO_MAX_TOOL_OUTPUT ?? 0) || undefined,
  maxCost: Number(process.env.MICRO_MAX_COST ?? 0) || undefined,
  sandbox: sandbox ?? undefined,
  sandboxMode,
})

console.log(`micro-harness server · ${server.url} · data ${dataDir}${guiDir ? ' · GUI on' : ''}${token ? ' · auth on' : ''}${sandbox ? ` · sandbox ${sandbox.kind}` : ''}`)

const shutdown = (): void => {
  console.log('\nshutting down…')
  // Hard exit. `Bun.serve().stop(true)` can block on live SSE streams (the GUI
  // keeps one open), and a hanging MCP close would keep us alive too; neither is
  // worth stalling a dev launcher over. The OS reclaims the socket on exit.
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// When launched by dev.sh/microh, die with it — so closing the terminal (or the
// launcher dying for any reason) doesn't leave an orphaned server behind.
// Reparenting to launchd (pid 1) changes process.ppid, which we poll for.
if (process.env.MICRO_EXIT_WITH_PARENT === '1') {
  const parentPid = process.ppid
  setInterval(() => {
    if (process.ppid !== parentPid) process.exit(0)
  }, 1000)
}
