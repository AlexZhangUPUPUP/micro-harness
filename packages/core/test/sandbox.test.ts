import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { bwrapArgs, bwrapSandbox, detectSandbox, seatbeltProfile, seatbeltSandbox } from '../src/sandbox.ts'
import { dispatch, makeTools } from '../src/tools.ts'

test('the seatbelt profile denies by default and confines writes', () => {
  const profile = seatbeltProfile({ writeRoots: ['/work/project'], network: false })
  expect(profile).toContain('(deny default)')
  expect(profile).toContain('(allow process-exec*)')
  expect(profile).toContain('(allow file-read*)')
  expect(profile).toContain('(subpath "/work/project")')
  expect(profile).toContain('(subpath "/private/tmp")')
  expect(profile).toContain('(subpath "/dev")')
  expect(profile).not.toContain('(allow network*)')
  expect(seatbeltProfile({ writeRoots: [], network: true })).toContain('(allow network*)')
})

test('detect: off is a no-op, require fails closed, auto warns', () => {
  expect(detectSandbox('off').sandbox).toBeNull()
  expect(() => detectSandbox('require', { has: () => false })).toThrow(/sandbox required/)
  const auto = detectSandbox('auto', { has: () => false })
  expect(auto.sandbox).toBeNull()
  expect(auto.notice).toContain('without it')
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    expect(detectSandbox('auto').sandbox?.kind).toBe('seatbelt')
  }
})

const canRunSeatbelt = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
const canRunBwrap =
  process.platform === 'linux' &&
  (() => {
    const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-net', '--', '/bin/true'], {
      timeout: 3000,
    })
    return r.status === 0
  })()

test.skipIf(!canRunSeatbelt)('seatbelt: writes stay inside the workspace', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'mh-sb-'))
  const outside = mkdtempSync(path.join(tmpdir(), 'mh-sb-out-'))
  try {
    const tools = makeTools()
    const sandbox = seatbeltSandbox()
    const run = (command: string) =>
      dispatch(tools, 'bash', JSON.stringify({ command }), { cwd, allowBash: true, sandbox, network: false })

    const inside = await run('echo hi > ok.txt && cat ok.txt')
    expect(inside.isError).toBeFalsy()
    expect(inside.output).toContain('hi')
    expect(existsSync(path.join(cwd, 'ok.txt'))).toBe(true)

    const outsideFile = path.join(outside, 'nope.txt')
    const denied = await run(`echo x > "${outsideFile}"`)
    expect(denied.isError).toBe(true)
    expect(existsSync(outsideFile)).toBe(false)

    const net = await run('curl -sS -m 2 -o /dev/null https://example.com')
    expect(net.isError).toBe(true)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})


test('bwrap confines the filesystem and drops the network by default', () => {
  const args = bwrapArgs({ cwd: '/work', writeRoots: ['/work', '/worktree'], network: false })
  expect(args.slice(0, 4)).toEqual(['--ro-bind', '/', '/', '--dev'])
  expect(args).toContain('--proc')
  expect(args).toContain('--unshare-pid')
  expect(args).toContain('--die-with-parent')
  expect(args.join(' ')).toContain('--bind /work /work')
  expect(args.join(' ')).toContain('--bind /worktree /worktree')
  expect(args).toContain('--unshare-net')
  expect(bwrapArgs({ cwd: '/work', writeRoots: ['/work'], network: true })).not.toContain('--unshare-net')

  const wrapped = bwrapSandbox().wrap('echo hi', { cwd: '/work', network: false })
  expect(wrapped.command).toBe('bwrap')
  expect(wrapped.args.slice(-4)).toEqual(['--', '/bin/sh', '-c', 'echo hi'])
})

test('detect: Linux prefers bwrap and fails closed when it cannot run', () => {
  const ok = detectSandbox('auto', { platform: 'linux', has: () => true, probe: () => true })
  expect(ok.sandbox?.kind).toBe('bwrap')
  expect(() => detectSandbox('require', { platform: 'linux', has: () => true, probe: () => false })).toThrow(/namespaces/)
  expect(() => detectSandbox('require', { platform: 'linux', has: () => false })).toThrow(/not installed/)
  const auto = detectSandbox('auto', { platform: 'linux', has: () => false })
  expect(auto.sandbox).toBeNull()
  expect(auto.notice).toContain('without it')
})

test.skipIf(!canRunBwrap)('bwrap: writes stay inside the workspace', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'mh-bwrap-'))
  const outside = path.join(homedir(), `.mh-bwrap-out-${Date.now()}`)
  try {
    const tools = makeTools()
    const sandbox = bwrapSandbox()
    const run = (command: string) =>
      dispatch(tools, 'bash', JSON.stringify({ command }), { cwd, allowBash: true, sandbox, network: false })

    const inside = await run('echo hi > ok.txt && cat ok.txt')
    expect(inside.isError).toBeFalsy()
    expect(inside.output).toContain('hi')

    const denied = await run(`echo x > "${outside}"`)
    expect(denied.isError).toBe(true)
    expect(existsSync(outside)).toBe(false)

    const net = await run('curl -sS -m 2 -o /dev/null https://example.com')
    expect(net.isError).toBe(true)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
