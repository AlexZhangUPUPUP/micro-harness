/**
 * Tool dispatch — the second half of a harness.
 *
 * A tool is just `{ name, description, JSON-schema, run(args, ctx) }`. The model
 * never executes anything: it emits tool calls, the loop dispatches them, and the
 * result (including errors) goes back as a `tool` message so the model can recover.
 */

import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { localFs, type FileSystem } from './fs.ts'
import type { Sandbox } from './sandbox.ts'
import { loadWebConfig } from './web/config.ts'
import { buildTools as buildWebTools } from './web/tools.ts'
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
const execFileAsync = promisify(execFile)

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
  wrap?: { command: string; args: string[]; env?: NodeJS.ProcessEnv },
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const options = {
      cwd,
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8' as const,
      // Unix 下建立独立进程组，取消时才能连同 shell 的后台子进程一起终止。
      detached: process.platform !== 'win32',
      ...(signal ? { signal } : {}),
      ...(wrap?.env ? { env: wrap.env } : {}),
    }
    const done = (err: unknown, stdout: string | Buffer, stderr: string | Buffer): void => {
      const code =
        err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code })
    }
    const child = wrap ? execFile(wrap.command, wrap.args, options, done) : exec(command, options, done)
    const onAbort = (): void => {
      if (!child.pid) return
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM')
        else child.kill()
      } catch {
        // 子进程已经结束时无需再次处理。
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.once('close', () => signal?.removeEventListener('abort', onAbort))
  })
}

export function makeTools(env: NodeJS.ProcessEnv = process.env): Tool[] {
  const tools: Tool[] = [
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
          old_string: { type: 'string', description: 'exact text to replace (single edit)' },
          new_string: { type: 'string', description: 'replacement text (single edit)' },
          replace_all: { type: 'boolean', description: 'replace every occurrence (single edit, default false)' },
          edits: {
            type: 'array',
            description:
              'several replacements applied in order and atomically; if any fails, the file is not written',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string' },
                new_string: { type: 'string' },
                replace_all: { type: 'boolean' },
              },
              required: ['old_string', 'new_string'],
            },
          },
        },
        required: ['path'],
      },
      async run(args, ctx) {
        const fs = fsFor(ctx)
        const handle = fs.resolve(args.path)
        const rel = fs.rel(handle)

        const batch = Array.isArray(args.edits) ? (args.edits as Array<Record<string, unknown>>) : null
        if (batch && batch.length === 0) return { output: 'edit_file: edits must not be empty', isError: true }
        const specs = batch ?? [
          { old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all },
        ]

        let original: string
        try {
          original = await fs.read(handle)
        } catch (err) {
          return { output: `edit_file: ${(err as Error).message}`, isError: true }
        }
        // 记录读取时版本，防止模型思考期间用户修改同一文件后被静默覆盖。
        const initialFingerprint = fs.fingerprint ? await fs.fingerprint(handle) : undefined

        let content = original
        let replacements = 0
        for (const [i, spec] of specs.entries()) {
          const at = batch ? `edit ${i + 1}: ` : ''
          const oldText = String(spec.old_string ?? '')
          const newText = String(spec.new_string ?? '')
          if (!oldText) return { output: `edit_file: ${at}old_string is required`, isError: true }
          if (oldText === newText) return { output: `edit_file: ${at}old_string and new_string are identical`, isError: true }

          const count = content.split(oldText).length - 1
          if (count === 0) return { output: `edit_file: ${at}old_string not found in ${rel}`, isError: true }
          if (count > 1 && spec.replace_all !== true) {
            return {
              output: `edit_file: ${at}old_string matches ${count} times in ${rel}; add more context or pass replace_all: true`,
              isError: true,
            }
          }

          // Avoid String.replace: `$&` and friends in new_string would be special.
          content =
            spec.replace_all === true
              ? content.split(oldText).join(newText)
              : (() => {
                  const idx = content.indexOf(oldText)
                  return content.slice(0, idx) + newText + content.slice(idx + oldText.length)
                })()
          replacements += spec.replace_all === true ? count : 1
        }

        // 写入前再次校验版本；不具备指纹能力的远端文件系统沿用旧行为。
        if (initialFingerprint !== undefined && fs.fingerprint) {
          const currentFingerprint = await fs.fingerprint(handle)
          if (currentFingerprint !== initialFingerprint) {
            return { output: `edit_file: ${rel} changed after it was read; reload and retry`, isError: true }
          }
        }
        await fs.write(handle, content)
        return {
          output: batch
            ? `edited ${rel}: ${specs.length} edit(s), ${replacements} replacement(s)`
            : `edited ${rel}: replaced ${replacements} occurrence${replacements === 1 ? '' : 's'}`,
        }
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
      name: 'search',
      description: 'Search text with ripgrep using bounded results and optional glob/path filters.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'literal or regular expression to search' },
          path: { type: 'string', description: 'file or directory path (default ".")' },
          glob: { type: 'string', description: 'optional ripgrep glob filter' },
          max_results: { type: 'integer', description: 'maximum matching lines (default 100)' },
        },
        required: ['query'],
      },
      async run(args, ctx) {
        // 通过参数数组调用 ripgrep，避免把搜索内容拼接进 shell 命令。
        const query = String(args.query ?? '')
        if (!query) return { output: 'search: query is required', isError: true }
        const max = Math.min(500, Math.max(1, Number(args.max_results) || 100))
        const target = String(args.path ?? '.')
        const rgArgs = ['--line-number', '--no-heading', '--color', 'never', '-m', String(max), query, target]
        if (args.glob) rgArgs.splice(4, 0, '--glob', String(args.glob))
        try {
          const result = await execFileAsync('rg', rgArgs, { cwd: ctx.cwd, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, signal: ctx.signal })
          return { output: clip(String(result.stdout).trim() || '(no matches)') }
        } catch (err) {
          const error = err as { code?: number; stdout?: string; stderr?: string; message?: string }
          if (error.code === 1) return { output: '(no matches)' }
          return { output: clip(String(error.stdout ?? error.stderr ?? error.message ?? error)), isError: true }
        }
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
        const { stdout, stderr, code } = await sh(command, ctx.cwd, 60_000, wrapped, ctx.signal)
        const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
        return { output: clip(combined || `(no output, exit ${code})`), isError: code !== 0 }
      },
    },
    {
      name: 'verify',
      description: 'Run a bounded verification command and return structured exit status and output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'test, typecheck, lint or build command' },
          timeout_ms: { type: 'integer', description: 'timeout in milliseconds, capped at 120000' },
        },
        required: ['command'],
      },
      async run(args, ctx) {
        // 验证命令沿用沙箱和取消信号，避免验证在主任务停止后继续运行。
        const command = String(args.command ?? '').trim()
        if (!command) return { output: 'verify: command is required', isError: true }
        const timeout = Math.min(120_000, Math.max(1_000, Number(args.timeout_ms) || 60_000))
        const wrapped = ctx.sandbox?.wrap(command, { cwd: ctx.cwd, network: ctx.network === true })
        const { stdout, stderr, code } = await sh(command, ctx.cwd, timeout, wrapped, ctx.signal)
        const output = clip([stdout.trim(), stderr.trim()].filter(Boolean).join('\n'))
        return {
          output: JSON.stringify({ command, exitCode: code, output: output || `(no output, exit ${code})` }),
          isError: code !== 0 ? true : undefined,
        }
      },
    },
  ]

  // First-party web tools are built in, not a bundled MCP server: they read the
  // same runtime toggle file and keep the `network` capability flag.
  const web = loadWebConfig(env)
  if (web.mode !== 'off') {
    for (const def of buildWebTools(web)) {
      tools.push({
        name: def.name,
        description: def.description,
        parameters: def.inputSchema,
        network: true,
        async run(args) {
          const result = await def.run(args)
          return { output: result.text, isError: result.isError }
        },
      })
    }
  }
  return tools
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
