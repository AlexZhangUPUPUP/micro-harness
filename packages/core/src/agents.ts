/**
 * Multi-agent orchestration — ROADMAP P3 / ARCHITECTURE §3.4.
 *
 * An *agent role* is a named configuration (model / system prompt / tool subset /
 * step budget). The `task` tool lets one agent delegate a self-contained job to
 * one or more child agents:
 *
 *   - single   — run one role once
 *   - parallel — run every task at once (bounded by a semaphore)
 *   - chain    — run tasks in order, substituting `{previous}` with the last result
 *   - race     — run every task at once, report all, mark the fastest as winner
 *
 * Children run in a fresh `Harness` (fresh `messages`, shared provider/tool/hub), so
 * the parent only ever sees the returned *result text* — never the child transcript.
 * That is the context firewall. Depth, concurrency, timeout, token and cost budgets
 * are enforced by the runner.
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { Harness, type ApprovalMode, type ConfirmFn } from './harness.ts'
import type { EventHub } from './events.ts'
import { createWorktree, isGitRepo, removeWorktree, type Worktree } from './isolation.ts'
import { localFs, type FileSystem } from './fs.ts'
import type { Provider } from './provider.ts'
import type { Tool, ToolContext, ToolResult } from './tools.ts'

// ---------------------------------------------------------------------- roles

export interface AgentRole {
  name: string
  model?: string
  systemPrompt?: string
  /** Restrict the role to these tool names (default: every tool). */
  tools?: string[]
  maxSteps?: number
}

export interface AgentRegistry {
  register(role: AgentRole): void
  get(name: string): AgentRole | undefined
  require(name: string): AgentRole
  has(name: string): boolean
  list(): string[]
}

export function createAgentRegistry(roles: AgentRole[] = []): AgentRegistry {
  const map = new Map<string, AgentRole>()
  for (const role of roles) map.set(role.name, role)
  return {
    register(role) {
      map.set(role.name, role)
    },
    get(name) {
      return map.get(name)
    },
    require(name) {
      const role = map.get(name)
      if (!role) throw new Error(`unknown agent role: ${name}`)
      return role
    },
    has(name) {
      return map.has(name)
    },
    list() {
      return [...map.keys()].sort()
    },
  }
}

const DEFAULT_AGENT_PROMPT = `You are a focused sub-agent. You only see the task below — not the parent
conversation — so treat it as complete and self-contained.

- Do the work yourself with the available tools; you cannot delegate further.
- Don't ask questions: make the best decision and proceed.
- Inspect before you change, and keep edits targeted.
- Finish with a concise, self-contained answer: the result, plus any file paths you
  changed. The parent sees only this message, so include what matters.`

/** The always-available fallback role. */
export const DEFAULT_ROLE: AgentRole = {
  name: 'agent',
  systemPrompt: DEFAULT_AGENT_PROMPT,
}

/**
 * Parse a role definition from markdown with a tiny frontmatter block:
 *
 *   ---
 *   name: researcher
 *   model: deepseek-chat
 *   tools: read_file, list_dir
 *   maxSteps: 8
 *   ---
 *   You are a research agent …
 */
export function parseAgentMarkdown(text: string, fallbackName: string): AgentRole {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  const meta: Record<string, string> = {}
  let body = text
  if (match) {
    for (const line of match[1]!.split(/\r?\n/)) {
      const at = line.indexOf(':')
      if (at <= 0) continue
      meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
    }
    body = match[2]!
  }
  const role: AgentRole = { name: meta.name || fallbackName }
  const systemPrompt = body.trim()
  if (systemPrompt) role.systemPrompt = systemPrompt
  if (meta.model) role.model = meta.model
  if (meta.maxSteps) role.maxSteps = Number(meta.maxSteps)
  if (meta.tools) role.tools = meta.tools.split(',').map((t) => t.trim()).filter(Boolean)
  return role
}

/** Load every `agents/*.md` role from a directory (missing dir → no roles). */
export function loadAgentRoles(dir: string): AgentRole[] {
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  return files.sort().map((f) => parseAgentMarkdown(readFileSync(path.join(dir, f), 'utf8'), f.replace(/\.md$/, '')))
}

// -------------------------------------------------------------------- runners

export interface AgentResult {
  agentId: string
  role: string
  ok: boolean
  text: string
  input: number
  output: number
  cost: number
  durationMs: number
  error?: string
  /** Set when the agent ran in its own git worktree (isolation: 'worktree'). */
  worktree?: Worktree | null
}

export interface AgentRunnerOptions {
  provider: Provider
  model: string
  cwd: string
  hub: EventHub
  roles: AgentRegistry
  /** Base tools handed to every agent (the `task` tool is added automatically). */
  tools: Tool[]
  /** Inherited by child agents that do not get their own worktree. */
  fs?: FileSystem
  allowBash?: boolean
  approval?: ApprovalMode
  confirm?: ConfirmFn
  /** Max nesting depth; a task at depth >= maxDepth is refused. Default 3. */
  maxDepth?: number
  /** Max concurrent child agents. Default 4. */
  maxConcurrency?: number
  /** Per-child wall-clock timeout. Default 5 minutes. */
  timeoutMs?: number
  /** Total tokens (input+output) a single child may spend before being aborted. */
  maxTokens?: number
  /** USD a single child may spend before being aborted. */
  maxCost?: number
  /** Run each child in its own git worktree (needs a git repo). Default 'none'. */
  isolation?: 'none' | 'worktree'
  /** Task id used to name worktree branches; defaults to a random id. */
  taskId?: string
  /** Starting point for child-agent sequence numbers (a resumed session's max). */
  startSeq?: number
  pricing?: { input: number; output: number }
}

interface SimpleSemaphore {
  acquire(): Promise<() => void>
  readonly active: number
}

function createSemaphore(limit: number): SimpleSemaphore {
  let active = 0
  const queue: Array<() => void> = []
  return {
    get active() {
      return active
    },
    async acquire() {
      if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve))
      active++
      let released = false
      return () => {
        if (released) return
        released = true
        active--
        queue.shift()?.()
      }
    },
  }
}

export class AgentRunner {
  readonly roles: AgentRegistry
  readonly #opts: AgentRunnerOptions
  readonly #semaphore: SimpleSemaphore
  readonly #taskId: string
  readonly #worktrees = new Map<string, Worktree>()
  #counter = 0

  constructor(opts: AgentRunnerOptions) {
    this.#opts = opts
    this.roles = opts.roles
    this.#taskId = opts.taskId ?? Math.random().toString(36).slice(2, 10)
    this.#semaphore = createSemaphore(Math.max(1, opts.maxConcurrency ?? 4))
    if (!this.roles.has(DEFAULT_ROLE.name)) this.roles.register(DEFAULT_ROLE)
  }

  get active(): number {
    return this.#semaphore.active
  }

  /** Worktrees created for isolated agents (agentId → worktree). */
  worktrees(): Map<string, Worktree> {
    return new Map(this.#worktrees)
  }

  /** Remove every worktree this runner created. Returns how many were removed. */
  cleanupWorktrees(): number {
    let n = 0
    for (const wt of this.#worktrees.values()) {
      try {
        removeWorktree({ cwd: this.#opts.cwd, path: wt.path, branch: wt.branch })
        n++
      } catch {
        /* best effort */
      }
    }
    this.#worktrees.clear()
    return n
  }

  /** 校验任务并持有并发名额，所有初始化失败也必须释放资源。 */
  async run(roleName: string, prompt: string, parentId: string, depth: number): Promise<AgentResult> {
    const role = this.roles.get(roleName)
    const started = Date.now()
    const agentId = `${parentId}/${roleName}-${++this.#counter}`
    // 提前失败不产生模型用量，也不创建子运行时。
    const fail = (error: string): AgentResult => ({
      agentId, role: roleName, ok: false, text: '', input: 0, output: 0, cost: 0,
      durationMs: Date.now() - started, error,
    })
    if (!role) return fail(`unknown agent role: ${roleName} (known: ${this.roles.list().join(', ')})`)
    const maxDepth = this.#opts.maxDepth ?? 3
    if (depth >= maxDepth) return fail(`max agent depth ${maxDepth} reached (depth ${depth})`)

    // 将隔离初始化纳入资源释放范围，禁止失败后使用共享工作区。
    const release = await this.#semaphore.acquire()
    // 保留原有计时起点，隔离准备时间也计入子任务超时。
    const controller = new AbortController()
    const timeoutMs = this.#opts.timeoutMs ?? 300_000
    const timer = setTimeout(() => controller.abort(new Error(`agent timed out after ${timeoutMs}ms`)), timeoutMs)
    try {
      const worktree = this.#prepareWorktree(agentId)
      const harness = this.#createHarness(role, agentId, parentId, depth, worktree)
      return await this.#executeChild(harness, prompt, roleName, agentId, started, worktree, controller)
    } catch (err) {
      // 保留 Git 的失败原因，供调用方决定是否重试。
      return fail(String((err as Error)?.message || err))
    } finally {
      // 初始化和执行共享同一个计时器与名额释放出口。
      clearTimeout(timer)
      release()
    }
  }

  /** 显式要求隔离时，必须成功建立独立工作区后才能继续。 */
  #prepareWorktree(agentId: string): Worktree | null {
    if (this.#opts.isolation !== 'worktree') return null
    // 无提交的仓库同样无法建立 worktree，因此统一拒绝。
    if (!isGitRepo(this.#opts.cwd)) throw new Error('worktree isolation requires a Git repository with a commit')
    try {
      const worktree = createWorktree({ cwd: this.#opts.cwd, taskId: this.#taskId, agentId })
      this.#worktrees.set(agentId, worktree)
      return worktree
    } catch (err) {
      // 隔离失败必须显式返回，避免并行任务误写共享目录。
      throw new Error(`worktree isolation failed: ${String((err as Error)?.message || err)}`)
    }
  }

  /** 根据已确认的隔离结果组装子运行时。 */
  #createHarness(role: AgentRole, agentId: string, parentId: string, depth: number, worktree: Worktree | null): Harness {
    const harness = new Harness({
      provider: this.#opts.provider,
      model: role.model ?? this.#opts.model,
      cwd: worktree?.path ?? this.#opts.cwd,
      // 隔离通过文件系统替换实现，工具无需感知 worktree。
      fs: worktree ? localFs(worktree.path) : this.#opts.fs,
      allowBash: this.#opts.allowBash,
      maxSteps: role.maxSteps,
      systemPrompt: role.systemPrompt ?? DEFAULT_AGENT_PROMPT,
      approval: this.#opts.approval,
      confirm: this.#opts.confirm,
      pricing: this.#opts.pricing,
      tools: this.#childTools(role),
      hub: this.#opts.hub,
      agentId, parentId, depth: depth + 1,
      startSeq: this.#opts.startSeq,
    })
    // 仅在隔离建立成功后发布工作区信息。
    if (worktree) {
      harness.log.emit({ type: 'agent.worktree', path: worktree.path, branch: worktree.branch, base: worktree.base })
    }
    return harness
  }

  /** 执行子任务并回收用量订阅，计时器由外层统一管理。 */
  async #executeChild(harness: Harness, prompt: string, role: string, agentId: string, started: number, worktree: Worktree | null, controller: AbortController): Promise<AgentResult> {
    let input = 0
    let output = 0
    let cost = 0
    // 只累计当前子任务的用量，并在超过预算时终止执行。
    const off = this.#opts.hub.on((e) => {
      if (e.agentId !== agentId || e.event.type !== 'usage') return
      input += e.event.input
      output += e.event.output
      cost += e.event.cost ?? 0
      const overTokens = this.#opts.maxTokens !== undefined && input + output > this.#opts.maxTokens
      const overCost = this.#opts.maxCost !== undefined && cost > this.#opts.maxCost
      if (overTokens || overCost) {
        controller.abort(new Error(overTokens ? 'token budget exceeded' : 'cost budget exceeded'))
      }
    })
    try {
      const text = await harness.send(prompt, controller.signal)
      return { agentId, role, ok: true, text, input, output, cost, durationMs: Date.now() - started, worktree }
    } catch (err) {
      // 取消时优先返回超时或预算原因，保留原有结果契约。
      const message = controller.signal.aborted
        ? String(controller.signal.reason?.message ?? controller.signal.reason ?? 'aborted')
        : String((err as Error)?.message || err)
      return { agentId, role, ok: false, text: '', input, output, cost, durationMs: Date.now() - started, error: message, worktree }
    } finally {
      // 正常结束和异常结束均撤销当前任务的用量订阅。
      off()
    }
  }

  #childTools(role: AgentRole): Tool[] {
    const names = role.tools
    const base = names ? this.#opts.tools.filter((t) => names.includes(t.name)) : [...this.#opts.tools]
    // A restricted role only gets `task` if it explicitly lists it.
    if (names && !names.includes('task')) return base
    return [...base, makeTaskTool(this)]
  }
}

// ------------------------------------------------------------------ task tool

export interface TaskSpec {
  role?: string
  prompt: string
}

export type TaskMode = 'single' | 'parallel' | 'chain' | 'race'

function summarize(result: AgentResult, winner = false): string {
  const cost = result.cost ? ` $${result.cost.toFixed(6)}` : ''
  const status = result.ok ? 'ok' : `error: ${result.error ?? 'failed'}`
  const head = `[${result.role} · ${result.agentId} · ${status} · ${Math.round(result.durationMs)}ms · ${result.input + result.output}tok${cost}]${winner ? ' ★ winner' : ''}`
  return `${head}\n${result.text || '(no output)'}`
}

function collectTasks(args: Record<string, unknown>): TaskSpec[] {
  const list = Array.isArray(args.tasks) ? (args.tasks as Array<Record<string, unknown>>) : []
  if (list.length) return list.map((t) => ({ role: t.role ? String(t.role) : undefined, prompt: String(t.prompt ?? '') }))
  if (args.prompt) return [{ role: args.role ? String(args.role) : undefined, prompt: String(args.prompt) }]
  return []
}

export async function runTask(runner: AgentRunner, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const mode = (String(args.mode ?? 'single') as TaskMode)
  const parentId = ctx.agentId ?? 'main'
  const depth = ctx.depth ?? 0
  const tasks = collectTasks(args)
  if (!tasks.length) return { output: 'no tasks given (provide `prompt`, or a non-empty `tasks` array)', isError: true }

  const roles = tasks.map((t) => t.role ?? 'agent')

  if (mode === 'single') {
    const result = await runner.run(roles[0]!, tasks[0]!.prompt, parentId, depth)
    return { output: summarize(result), isError: !result.ok }
  }

  if (mode === 'parallel') {
    const results = await Promise.all(tasks.map((t, i) => runner.run(roles[i]!, t.prompt, parentId, depth)))
    return { output: results.map((r) => summarize(r)).join('\n\n'), isError: results.every((r) => !r.ok) }
  }

  if (mode === 'chain') {
    const results: AgentResult[] = []
    let previous = ''
    for (let i = 0; i < tasks.length; i++) {
      const prompt = tasks[i]!.prompt.replaceAll('{previous}', previous)
      const result = await runner.run(roles[i]!, prompt, parentId, depth)
      results.push(result)
      previous = result.text
    }
    return { output: results.map((r) => summarize(r)).join('\n\n'), isError: results.every((r) => !r.ok) }
  }

  if (mode === 'race') {
    const results = await Promise.all(tasks.map((t, i) => runner.run(roles[i]!, t.prompt, parentId, depth)))
    const winnerIndex = results.reduce((best, r, i) => (r.durationMs < results[best]!.durationMs ? i : best), 0)
    return {
      output: results.map((r, i) => summarize(r, i === winnerIndex)).join('\n\n'),
      isError: results.every((r) => !r.ok),
    }
  }

  return { output: `unknown task mode: ${mode} (expected single|parallel|chain|race)`, isError: true }
}

/** A `task` tool bound to a runner; children inherit the same tool (recursion). */
export function makeTaskTool(runner: AgentRunner): Tool {
  return {
    name: 'task',
    description:
      'Delegate work to sub-agents. mode=single runs one role; parallel runs all at once; chain runs in order replacing {previous}; race runs all at once and marks the fastest winner. Each child sees only its prompt and returns only its final answer.',
    mutating: true,
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['single', 'parallel', 'chain', 'race'], description: 'orchestration mode' },
        role: { type: 'string', description: 'agent role for single mode' },
        prompt: { type: 'string', description: 'prompt for single mode' },
        tasks: {
          type: 'array',
          description: 'tasks for parallel/chain/race',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', description: 'agent role (default "agent")' },
              prompt: { type: 'string', description: 'the task prompt' },
            },
            required: ['prompt'],
          },
        },
      },
      required: ['mode'],
    },
    run: (args, ctx) => runTask(runner, args, ctx),
  }
}
