import { test, expect } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detectSandbox, seatbeltProfile, seatbeltSandbox } from '../src/sandbox.ts'
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
