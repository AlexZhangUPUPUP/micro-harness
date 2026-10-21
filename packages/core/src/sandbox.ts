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

import { spawnSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type SandboxMode = 'off' | 'auto' | 'require'
export type SandboxKind = 'none' | 'seatbelt' | 'bwrap'

export type SandboxSecrets = 'deny' | 'allow'

export interface SecretPath {
  path: string
  dir: boolean
}

export interface Sandbox {
  readonly kind: Exclude<SandboxKind, 'none'>
  /**
   * Wrap a shell command. `network` is the only capability that is not a path;
   * when false the process gets no network access at all.
   */
  wrap(command: string, opts: { cwd: string; network: boolean }): { command: string; args: string[]; env?: NodeJS.ProcessEnv }
}

export interface SandboxResult {
  sandbox: Sandbox | null
  /** Set when a sandbox was asked for but is unavailable (auto mode only). */
  notice?: string
}

/** Paths a sandboxed command almost always needs beyond the workspace. */
const TMP_ROOTS = ['/tmp', '/private/tmp', '/dev']

/** Credential stores a sandboxed shell has no business reading by default. */
const SECRET_CANDIDATES: Array<[string, boolean]> = [
  ['.ssh', true],
  ['.aws', true],
  ['.gnupg', true],
  ['.config/gh', true],
  ['.config/gcloud', true],
  ['.kube', true],
  ['.docker/config.json', false],
  ['.netrc', false],
]

export function secretPaths(home = homedir()): SecretPath[] {
  return SECRET_CANDIDATES.flatMap(([rel, dir]) => {
    const p = path.join(home, rel)
    if (!existsSync(p)) return []
    try {
      return [{ path: realpathSync(p), dir }]
    } catch {
      return [{ path: p, dir }]
    }
  })
}

/** Names that must not leak into a sandboxed shell. */
const SECRET_ENV = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIALS?)$/i
const SECRET_ENV_EXACT = new Set([
  'SSH_AUTH_SOCK',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'MICRO_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'BOCHA_API_KEY',
  'DEEPSEEK_API_KEY',
])

export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (SECRET_ENV_EXACT.has(key) || SECRET_ENV.test(key)) continue
    out[key] = value
  }
  return out
}

/**
 * Seatbelt policy, deny-by-default and read-everything.
 *
 * `process-exec*` is not covered by `process*` in practice, and `/dev` must be
 * writable or `/dev/null`, pipes and `/dev/tty` fail in confusing ways.
 */
export function seatbeltProfile(opts: {
  writeRoots: string[]
  network: boolean
  denyRead?: SecretPath[]
}): string {
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
    // A later deny wins once the path is resolved (use real paths, not /tmp).
    ...(opts.denyRead ?? []).map(
      (p) => `(deny file-read* (${p.dir ? 'subpath' : 'literal'} "${p.path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"))`,
    ),
    `(allow file-write* ${writes})`,
    ...(opts.network ? ['(allow network*)'] : []),
  ].join('\n')
}

export function seatbeltSandbox(extraWriteRoots: string[] = [], secrets: SandboxSecrets = 'deny'): Sandbox {
  const denyRead = secrets === 'deny' ? secretPaths() : []
  return {
    kind: 'seatbelt',
    wrap(command, opts) {
      const profile = seatbeltProfile({
        writeRoots: [opts.cwd, ...extraWriteRoots],
        network: opts.network,
        denyRead,
      })
      return {
        command: 'sandbox-exec',
        args: ['-p', profile, '/bin/sh', '-c', command],
        ...(secrets === 'deny' ? { env: scrubEnv(process.env) } : {}),
      }
    },
  }
}

/**
 * bubblewrap: namespaces instead of a policy engine. `/` is read-only, the
 * workspace (and any worktree) is bound read-write, `/tmp` is shared, and the
 * network namespace is dropped unless it is explicitly allowed.
 */
export function bwrapArgs(opts: {
  cwd: string
  writeRoots: string[]
  network: boolean
  hidePaths?: SecretPath[]
}): string[] {
  const roots = [...new Set(opts.writeRoots)]
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--proc', '/proc',
    '--bind', '/tmp', '/tmp',
    ...(opts.hidePaths ?? []).flatMap((p) =>
      p.dir ? ['--tmpfs', p.path] : ['--ro-bind', '/dev/null', p.path],
    ),
    ...roots.flatMap((r) => ['--bind', r, r]),
    '--unshare-pid',
    '--die-with-parent',
    '--new-session',
    '--chdir', opts.cwd,
  ]
  if (!opts.network) args.push('--unshare-net')
  return args
}

export function bwrapSandbox(extraWriteRoots: string[] = [], secrets: SandboxSecrets = 'deny'): Sandbox {
  const hidePaths = secrets === 'deny' ? secretPaths() : []
  return {
    kind: 'bwrap',
    wrap(command, opts) {
      return {
        command: 'bwrap',
        args: [
          ...bwrapArgs({
            cwd: opts.cwd,
            writeRoots: [opts.cwd, ...extraWriteRoots],
            network: opts.network,
            hidePaths,
          }),
          '--',
          '/bin/sh',
          '-c',
          command,
        ],
        ...(secrets === 'deny' ? { env: scrubEnv(process.env) } : {}),
      }
    },
  }
}

/** Whether bubblewrap can actually create the namespaces we need. */
function bwrapUsable(): boolean {
  const probe = spawnSync(
    'bwrap',
    ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-net', '--', '/bin/true'],
    { timeout: 3000, stdio: 'ignore' },
  )
  return probe.status === 0
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
  opts: {
    has?: (bin: string) => boolean
    /** Can the platform's primitive actually run here? Injectable for tests. */
    probe?: () => boolean
    extraWriteRoots?: string[]
    /** Default: hide credential stores and scrub secret-looking env vars. */
    secrets?: SandboxSecrets
    platform?: NodeJS.Platform
  } = {},
): SandboxResult {
  // Anything that is not a real mode (empty env vars, typos) means "off".
  if (mode !== 'auto' && mode !== 'require') return { sandbox: null }
  const has = opts.has ?? whichIsDefault
  const platform = opts.platform ?? process.platform
  const probe = opts.probe ?? bwrapUsable

  const secrets = opts.secrets ?? 'deny'
  if (platform === 'darwin' && has('sandbox-exec')) {
    return { sandbox: seatbeltSandbox(opts.extraWriteRoots ?? [], secrets) }
  }
  if (platform === 'linux' && has('bwrap') && probe()) {
    return { sandbox: bwrapSandbox(opts.extraWriteRoots ?? [], secrets) }
  }

  const reason =
    platform === 'darwin'
      ? 'sandbox-exec not found'
      : platform === 'linux'
        ? has('bwrap')
          ? 'bubblewrap cannot create the namespaces it needs (unprivileged user namespaces disabled?)'
          : 'bubblewrap is not installed'
        : `no OS sandbox for ${platform}`

  if (mode === 'require') throw new Error(`sandbox required but unavailable: ${reason}`)
  return { sandbox: null, notice: `sandbox requested but unavailable (${reason}); running without it` }
}
