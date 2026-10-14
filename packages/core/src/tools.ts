/**
 * Tool dispatch — the second half of a harness.
 *
 * A tool is just `{ name, description, JSON-schema, run(args, ctx) }`. The model
 * never executes anything: it emits tool calls, the loop dispatches them, and the
 * result (including errors) goes back as a `tool` message so the model can recover.
 */

import { exec } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ToolDef } from './model.ts'

export interface ToolContext {
  cwd: string
  allowBash: boolean
}

export interface ToolResult {
  output: string
  isError?: boolean
}

export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** True when the tool can change the workspace (needs approval in `suggest` mode). */
  mutating?: boolean
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

const MAX_OUTPUT = 20_000

function clip(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n… (${text.length - max} more characters truncated)`
}

/** Resolve a path inside the sandbox; refuse anything that escapes it. */
function safe(cwd: string, p: unknown): string {
  const root = path.resolve(cwd)
  const abs = path.resolve(root, String(p ?? '.'))
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes the working directory: ${String(p)}`)
  }
  return abs
}

function rel(cwd: string, abs: string): string {
  const r = path.relative(path.resolve(cwd), abs)
  return r === '' ? '.' : r
}

function sh(command: string, cwd: string, timeout = 60_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code })
      },
    )
  })
}

export function makeTools(): Tool[] {
  return [
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file. Returns numbered lines.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'file path, relative to the working directory' },
          offset: { type: 'integer', description: '1-based first line (optional)' },
          limit: { type: 'integer', description: 'max number of lines (optional)' },
        },
        required: ['path'],
      },
      async run(args, ctx) {
        const abs = safe(ctx.cwd, args.path)
        const text = await fs.readFile(abs, 'utf8')
        const lines = text.split('\n')
        const start = Math.max(0, (Number(args.offset) || 1) - 1)
        const end = args.limit ? start + Number(args.limit) : lines.length
        const slice = lines.slice(start, end)
        const out = slice.map((l, i) => `${String(start + i + 1).padStart(5)}  ${l}`).join('\n')
        return { output: clip(out) }
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content (creates parent directories).',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'file path, relative to the working directory' },
          content: { type: 'string', description: 'full file content' },
        },
        required: ['path', 'content'],
      },
      async run(args, ctx) {
        const abs = safe(ctx.cwd, args.path)
        const content = String(args.content ?? '')
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await fs.writeFile(abs, content, 'utf8')
        return { output: `wrote ${Buffer.byteLength(content)} bytes to ${rel(ctx.cwd, abs)}` }
      },
    },
    {
      name: 'list_dir',
      description: 'List the entries of a directory (directories end with "/").',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'directory path (default ".")' } },
      },
      async run(args, ctx) {
        const abs = safe(ctx.cwd, args.path ?? '.')
        const entries = await fs.readdir(abs, { withFileTypes: true })
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        const out = entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name)).join('\n')
        return { output: clip(out || '(empty)') }
      },
    },
    {
      name: 'bash',
      description: 'Run a shell command in the working directory. Disabled unless the harness is started with --allow-bash.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'the command to run' } },
        required: ['command'],
      },
      async run(args, ctx) {
        const command = String(args.command ?? '').trim()
        if (!command) return { output: 'no command given', isError: true }
        const { stdout, stderr, code } = await sh(command, ctx.cwd)
        const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
        return { output: clip(combined || `(no output, exit ${code})`), isError: code !== 0 }
      },
    },
  ]
}

export function toolDefs(tools: Tool[]): ToolDef[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
}

export async function dispatch(
  tools: Tool[],
  name: string,
  rawArgs: string,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) return { output: `unknown tool: ${name}`, isError: true }
  if (name === 'bash' && !ctx.allowBash) return { output: 'bash is disabled (start with --allow-bash)', isError: true }

  let args: Record<string, unknown> = {}
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {}
  } catch (err) {
    return { output: `invalid JSON arguments: ${(err as Error).message}`, isError: true }
  }

  try {
    return await tool.run(args, ctx)
  } catch (err) {
    // Tool failures are normal agent input, not crashes: hand them back.
    return { output: String((err as Error)?.message || err), isError: true }
  }
}
