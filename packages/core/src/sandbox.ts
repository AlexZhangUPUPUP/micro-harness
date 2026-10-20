/**
 * OS-level confinement for the shell tool.
 *
 * The permission presets decide *which* tools exist and whether they must be
 * approved; this decides what the process is allowed to touch once it runs.
 * It is a second line of defence: the file tools already check paths, but a
 * shell command can do anything the user can.
 *
 * Modes:
 *   off      — never wrap (default; no behaviour change)
 *   auto     — use a sandbox when the platform provides one, otherwise warn
 *   require  — fail closed: refuse to run without one
 *
 * Implemented here: macOS Seatbelt. Linux bubblewrap is the next milestone; the
 * `bwrap` kind is reserved so callers and events do not need to change later.
 */

import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

export type SandboxMode = 'off' | 'auto' | 'require'
export type SandboxKind = 'none' | 'seatbelt' | 'bwrap'

export interface Sandbox {
  readonly kind: Exclude<SandboxKind, 'none'>
  /**
   * Wrap a shell command. `network` is the only capability that is not a path;
   * when false the process gets no network access at all.
   */
  wrap(command: string, opts: { cwd: string; network: boolean }): { command: string; args: string[] }
}

export interface SandboxResult {
  sandbox: Sandbox | null
  /** Set when a sandbox was asked for but is unavailable (auto mode only). */
  notice?: string
}

/** Paths a sandboxed command almost always needs beyond the workspace. */
const TMP_ROOTS = ['/tmp', '/private/tmp', '/dev']

/**
 * Seatbelt policy, deny-by-default and read-everything.
 *
 * `process-exec*` is not covered by `process*` in practice, and `/dev` must be
 * writable or `/dev/null`, pipes and `/dev/tty` fail in confusing ways.
 */
export function seatbeltProfile(opts: { writeRoots: string[]; network: boolean }): string {
  // macOS resolves /tmp and /var to /private/...; Seatbelt matches the literal
  // path, so both spellings must be present or writes fail with EPERM.
  const roots = new Set<string>()
  for (const root of [...opts.writeRoots, ...TMP_ROOTS]) {
    roots.add(root)
    try {
      roots.add(realpathSync(root))
    } catch {
      /* the path may not exist yet; the literal form is enough */
    }
  }
  const writes = [...roots]
    .map((p) => `(subpath "${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`)
    .join(' ')
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow process-exec*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    `(allow file-write* ${writes})`,
    ...(opts.network ? ['(allow network*)'] : []),
  ].join('\n')
}

export function seatbeltSandbox(extraWriteRoots: string[] = []): Sandbox {
  return {
    kind: 'seatbelt',
    wrap(command, opts) {
      const profile = seatbeltProfile({
        writeRoots: [opts.cwd, ...extraWriteRoots],
        network: opts.network,
      })
      return { command: 'sandbox-exec', args: ['-p', profile, '/bin/sh', '-c', command] }
    },
  }
}

/** `which`, without spawning a process; injectable so tests are deterministic. */
export function whichIsDefault(bin: string): boolean {
  if (process.platform === 'darwin' && bin === 'sandbox-exec') return existsSync('/usr/bin/sandbox-exec')
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => existsSync(path.join(dir, bin)))
}

export function detectSandbox(
  mode: SandboxMode,
  opts: { has?: (bin: string) => boolean; extraWriteRoots?: string[] } = {},
): SandboxResult {
  if (mode === 'off') return { sandbox: null }
  const has = opts.has ?? whichIsDefault

  if (process.platform === 'darwin' && has('sandbox-exec')) {
    return { sandbox: seatbeltSandbox(opts.extraWriteRoots ?? []) }
  }

  // Linux (bubblewrap) is the next milestone; until then the honest answer is
  // "unavailable", not a silent no-op.
  const reason =
    process.platform === 'darwin'
      ? 'sandbox-exec not found'
      : process.platform === 'linux'
        ? 'no supported sandbox on this platform yet (bubblewrap lands in the next milestone)'
        : `no OS sandbox for ${process.platform}`

  if (mode === 'require') throw new Error(`sandbox required but unavailable: ${reason}`)
  return { sandbox: null, notice: `sandbox requested but unavailable (${reason}); running without it` }
}
