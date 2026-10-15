/**
 * P10 eval task set — small, self-contained coding tasks with deterministic graders.
 *
 * Each `check` is a pure predicate over the sandbox directory after the run: file
 * contents/existence, a regex over the final answer, or the exit code of a shell
 * command. No model judges anything here, which is what makes the pass/fail call
 * honest and reproducible.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type Check = (cwd: string) => boolean | Promise<boolean>

export interface SetupFile {
  path: string
  content: string
}

export interface Task {
  id: string
  title: string
  prompt: string
  setup?: SetupFile[]
  check: Check
  timeoutMs?: number
}

/** Run a shell command in a sandbox dir, with `bun` guaranteed to be on PATH. */
function run(cwd: string, command: string): { code: number; stdout: string; stderr: string } {
  const bunDirs = [path.dirname(process.execPath)]
  const home = process.env.HOME ?? process.env.USERPROFILE
  if (home) bunDirs.push(path.join(home, '.bun', 'bin'))
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PATH: `${bunDirs.join(':')}:${process.env.PATH ?? ''}` },
  })
  return { code: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

/** Total read: returns '' when the file is missing or unreadable, so graders never throw. */
function read(cwd: string, rel: string): string {
  try {
    return readFileSync(path.join(cwd, rel), 'utf8')
  } catch {
    return ''
  }
}

function exists(cwd: string, rel: string): boolean {
  return existsSync(path.join(cwd, rel))
}

export const tasks: Task[] = [
  {
    id: 'exact-file',
    title: 'Create a file with exact content',
    prompt:
      'Create a file named `hello.txt` whose entire content is exactly `hello, micro-harness` followed by a single newline. No other bytes and no extra spaces.',
    check: (cwd) => exists(cwd, 'hello.txt') && read(cwd, 'hello.txt') === 'hello, micro-harness\n',
  },
  {
    id: 'fix-failing-test',
    title: 'Fix a bug so `bun test` passes',
    timeoutMs: 120_000,
    setup: [
      { path: 'sum.ts', content: 'export function sum(a: number, b: number): number {\n  return a - b\n}\n' },
      {
        path: 'sum.test.ts',
        content:
          "import { expect, test } from 'bun:test'\nimport { sum } from './sum.ts'\n\ntest('sum adds two numbers', () => {\n  expect(sum(2, 3)).toBe(5)\n})\n",
      },
    ],
    prompt:
      'Run `bun test` in the workspace; it currently fails. Find the bug in `sum.ts` and fix it so the tests pass. Do not modify `sum.test.ts`.',
    check: (cwd) => {
      const r = run(cwd, 'bun test')
      return r.code === 0 && read(cwd, 'sum.ts').includes('return a + b') && read(cwd, 'sum.test.ts').includes('toBe(5)')
    },
  },
  {
    id: 'rename-symbol',
    title: 'Rename a symbol across two files',
    setup: [
      { path: 'lib.ts', content: 'export function oldName(x: number): number {\n  return x * 2\n}\n' },
      {
        path: 'main.ts',
        content: "import { oldName } from './lib.ts'\n\nconst result = oldName(21)\nconsole.log(result)\n",
      },
    ],
    prompt:
      'Rename the exported function `oldName` to `doubled` across the workspace: update its definition in `lib.ts` and every use in `main.ts`. No reference to `oldName` may remain.',
    check: (cwd) => {
      const lib = read(cwd, 'lib.ts')
      const main = read(cwd, 'main.ts')
      return (
        lib.includes('export function doubled') &&
        !lib.includes('oldName') &&
        main.includes('doubled') &&
        !main.includes('oldName')
      )
    },
  },
  {
    id: 'json-shape',
    title: 'Produce a JSON file with a specific shape',
    prompt:
      'Create `config.json` containing a single JSON object with exactly these four keys: `name` (a string), `port` (an integer between 1024 and 65535), `retries` (a non-negative integer), `enabled` (a boolean). Valid JSON only — no comments, no trailing commas.',
    check: (cwd) => {
      let parsed: unknown
      try {
        parsed = JSON.parse(read(cwd, 'config.json'))
      } catch {
        return false
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
      const obj = parsed as Record<string, unknown>
      if (Object.keys(obj).length !== 4) return false
      if (typeof obj.name !== 'string') return false
      if (typeof obj.port !== 'number' || !Number.isInteger(obj.port) || obj.port < 1024 || obj.port > 65535) return false
      if (typeof obj.retries !== 'number' || !Number.isInteger(obj.retries) || obj.retries < 0) return false
      if (typeof obj.enabled !== 'boolean') return false
      return true
    },
  },
  {
    id: 'flip-flag',
    title: 'Find and change one line',
    setup: [{ path: 'settings.env', content: 'PORT=8080\nDEBUG=false\nLOG_LEVEL=info\n' }],
    prompt:
      'In `settings.env`, find the line that sets the debug flag and change its value to `true`. Leave every other line exactly as it is.',
    check: (cwd) => {
      const c = read(cwd, 'settings.env').replace(/\r\n/g, '\n')
      return c === 'PORT=8080\nDEBUG=true\nLOG_LEVEL=info\n' || c === 'PORT=8080\nDEBUG=true\nLOG_LEVEL=info'
    },
  },
  {
    id: 'read-and-write',
    title: 'Read a file, then write what it says',
    setup: [{ path: 'clue.txt', content: 'serendipity\n' }],
    prompt:
      'Read `clue.txt`; it contains a single word. Write that exact word (no surrounding whitespace or punctuation) into a new file `result.txt`.',
    check: (cwd) => exists(cwd, 'result.txt') && read(cwd, 'result.txt').trim() === 'serendipity',
  },
  {
    id: 'append-section',
    title: 'Append without breaking existing content',
    setup: [{ path: 'notes.md', content: '# Project Notes\n\nSome existing content.\n' }],
    prompt:
      'Append a new section titled `## Changelog` to the end of `notes.md`, containing the bullet `- 2025-01-01: first release`. Do not modify or delete any of the existing content.',
    check: (cwd) => {
      const content = read(cwd, 'notes.md')
      return (
        content.startsWith('# Project Notes\n\nSome existing content.\n') &&
        content.includes('## Changelog') &&
        content.includes('- 2025-01-01: first release')
      )
    },
  },
  {
    id: 'hello-run',
    title: 'Make `bun run` print the right thing',
    timeoutMs: 120_000,
    setup: [{ path: 'hello.ts', content: "console.log('Goodbye, world!')\n" }],
    prompt:
      "The file `hello.ts` should print exactly `Hello, world!` when run with `bun run hello.ts`. Fix it, then verify by running it.",
    check: (cwd) => {
      const r = run(cwd, 'bun run hello.ts')
      return r.code === 0 && r.stdout.trim() === 'Hello, world!'
    },
  },
]
