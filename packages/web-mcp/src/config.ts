/**
 * Web access has two independent switches, on purpose:
 *
 *   MICRO_WEB = off | fetch | search | all   (boot-level)
 *     Which tools this server even advertises. `off` also means micro-harness
 *     should not spawn us at all.
 *
 *   <toggleFile> = { "enabled": false }      (runtime, read per call)
 *     A soft off switch so the GUI can disable web access live — without the
 *     MCP hot-plug the harness deliberately does not support. The tools stay
 *     listed; a call while disabled returns a structured refusal, which is more
 *     useful to the model than the tool silently vanishing.
 *
 * On top of that the permission preset decides whether the tools are injected
 * at all (read-only / workspace never get them); that gate lives in the server,
 * not here.
 */

import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export type WebMode = 'off' | 'fetch' | 'search' | 'all'

export interface WebConfig {
  mode: WebMode
  /** Search backend: bing (no key) | baidu (no key) | bocha | searxng | brave | tavily | exa. */
  provider: string
  bochaKey: string
  braveKey: string
  tavilyKey: string
  exaKey: string
  searxngUrl: string
  /** Hard cap on characters handed back to the model, per call. */
  maxChars: number
  timeoutMs: number
  maxBytes: number
  userAgent: string
  /** Runtime soft switch; written by the GUI. */
  toggleFile: string
}

export const DEFAULT_USER_AGENT =
  'micro-harness-web/0.1 (+https://github.com/AlexZhangUPUPUP/micro-harness)'

const MODES: WebMode[] = ['off', 'fetch', 'search', 'all']

export function loadWebConfig(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): WebConfig {
  const rawMode = String(env.MICRO_WEB ?? 'all').trim().toLowerCase()
  const mode: WebMode = (MODES as string[]).includes(rawMode) ? (rawMode as WebMode) : 'all'
  return {
    mode,
    provider: String(env.MICRO_SEARCH_PROVIDER ?? 'bing').trim().toLowerCase() || 'bing',
    bochaKey: env.BOCHA_API_KEY ?? env.MICRO_BOCHA_KEY ?? '',
    braveKey: env.BRAVE_API_KEY ?? '',
    tavilyKey: env.TAVILY_API_KEY ?? '',
    exaKey: env.EXA_API_KEY ?? '',
    searxngUrl: env.MICRO_SEARXNG_URL ?? '',
    maxChars: Number(env.MICRO_WEB_MAX_CHARS ?? 20_000) || 20_000,
    timeoutMs: Number(env.MICRO_WEB_TIMEOUT_MS ?? 20_000) || 20_000,
    maxBytes: Number(env.MICRO_WEB_MAX_BYTES ?? 2_000_000) || 2_000_000,
    userAgent: env.MICRO_WEB_USER_AGENT || DEFAULT_USER_AGENT,
    toggleFile: env.MICRO_WEB_TOGGLE_FILE || path.join(home, '.micro-harness', 'web.json'),
  }
}

/** Which tools the boot-level mode advertises. */
export function capabilities(mode: WebMode): { fetch: boolean; search: boolean } {
  return {
    fetch: mode === 'fetch' || mode === 'all',
    search: mode === 'search' || mode === 'all',
  }
}

/**
 * The runtime soft switch. Missing file, unreadable file or a parse error all
 * mean "enabled": a broken toggle must not silently cut the network off.
 */
export function runtimeEnabled(toggleFile: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(toggleFile, 'utf8')) as { enabled?: unknown }
    return parsed?.enabled !== false
  } catch {
    return true
  }
}
