/**
 * Tool dispatch — the second half of a harness.
 *
 * A tool is just `{ name, description, JSON-schema, run(args, ctx) }`. The model
 * never executes anything: it emits tool calls, the loop dispatches them, and the
 * result (including errors) goes back as a `tool` message so the model can recover.
 */

import { exec, execFile } from 'node:child_process'
import { localFs, type FileSystem } from './fs.ts'
import type { Sandbox } from './sandbox.ts'
import type { ToolDef } from './model.ts'

export interface ToolContext {
  cwd: string
  allowBash: boolean
  /**
   * The capability seam the file tools run against. Defaults to the real
   * filesystem rooted at `cwd`; substitute another provider to move the whole
   * environment without changing the tool surface.
   */
  fs?: FileSystem
  /** The agent running the tool — used by the `task` tool to link sub-agents. */
  agentId?: string
  /** Nesting depth of the running agent (root = 0); enforces `maxDepth`. */
  depth?: number
  /** Aborted when the current turn is cancelled; propagated to sub-agents. */
  signal?: AbortSignal
  /** OS-level confinement for shell commands, when one is configured. */
  sandbox?: Sandbox
  /** Whether a sandboxed command may reach the network (default: no). */
  network?: boolean
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
  /** True when the tool reaches the network (gated by the permission preset, and prompted in `auto-review`). */
  network?: boolean
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>
}

const MAX_OUTPUT = 20_000

function clip(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n… (${text.length - max} more characters truncated)`
}

/** The filesystem this call should use: the injected provider, or local disk. */
const fsFor = (ctx: ToolContext): FileSystem => ctx.fs ?? localFs(ctx.cwd)

function sh(
  command: string,
  cwd: string,
  timeout = 60_000,
  wrap?: { command: string; args: string[] },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const options = { cwd, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' as const }
    const done = (err: unknown, stdout: string | Buffer, stderr: string | Buffer): void => {
      const code =
        err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code })
    }
    if (wrap) execFile(wrap.command, wrap.args, options, done)
    else exec(command, options, done)
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
        const fs = fsFor(ctx)
        const handle = fs.resolve(args.path)
        const text = await fs.read(handle)
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
        const fs = fsFor(ctx)
        const handle = fs.resolve(args.path)
        const content = String(args.content ?? '')
        await fs.write(handle, content)
        return { output: `wrote ${Buffer.byteLength(content)} bytes to ${fs.rel(handle)}` }
      },
    },
    {
      name: 'edit_file',
      description:
        'Replace an exact string in a text file. old_string must match exactly once unless replace_all is true; ' +
        'nothing is written when the match is missing or ambiguous.',
      mutating: true,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'file path, relative to the working directory' },
          old_string: { type: 'string', description: 'exact text to replace (include enough context to be unique)' },
          new_string: { type: 'string', description: 'replacement text' },
          replace_all: { type: 'boolean', description: 'replace every occurrence (default false)' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
      async run(args, ctx) {
        const fs = fsFor(ctx)
        const handle = fs.resolve(args.path)
        const rel = fs.rel(handle)
        const oldText = String(args.old_string ?? '')
        const newText = String(args.new_string ?? '')
        if (!oldText) return { output: 'edit_file: old_string is required', isError: true }
        if (oldText === newText) return { output: 'edit_file: old_string and new_string are identical', isError: true }

        let original: string
        try {
          original = await fs.read(handle)
        } catch (err) {
          return { output: `edit_file: ${(err as Error).message}`, isError: true }
        }

        const count = original.split(oldText).length - 1
        if (count === 0) return { output: `edit_file: old_string not found in ${rel}`, isError: true }
        const all = args.replace_all === true
        if (count > 1 && !all) {
          return {
            output: `edit_file: old_string matches ${count} times in ${rel}; add more context or pass replace_all: true`,
            isError: true,
          }
        }

        // Avoid String.replace: `$&` and friends in new_string would be special.
        const updated = all
          ? original.split(oldText).join(newText)
          : (() => {
              const at = original.indexOf(oldText)
              return original.slice(0, at) + newText + original.slice(at + oldText.length)
            })()
        await fs.write(handle, updated)
        return { output: `edited ${rel}: replaced ${all ? count : 1} occurrence${all && count !== 1 ? 's' : ''}` }
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
        const fs = fsFor(ctx)
        const handle = fs.resolve(args.path ?? '.')
        const entries = await fs.list(handle)
        entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
        const out = entries.map((e) => (e.dir ? e.name + '/' : e.name)).join('\n')
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
        const wrapped = ctx.sandbox?.wrap(command, { cwd: ctx.cwd, network: ctx.network === true })
        const { stdout, stderr, code } = await sh(command, ctx.cwd, 60_000, wrapped)
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
