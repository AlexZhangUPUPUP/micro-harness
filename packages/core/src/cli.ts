#!/usr/bin/env bun
/**
 * CLI — ROADMAP P5.
 *
 *   micro-harness "one shot prompt"          one-shot run (legacy form)
 *   micro-harness                           interactive REPL (slash commands)
 *   micro-harness run "task" ["task" …]      queued run
 *   micro-harness run --auto --tasks f.txt   unattended driver (budget/timeout)
 *
 * Config comes from flags or the environment:
 *   MICRO_BASE_URL / OPENAI_BASE_URL   e.g. https://api.deepseek.com
 *   MICRO_API_KEY  / OPENAI_API_KEY
 *   MICRO_MODEL                        e.g. deepseek-chat
 *
 * Interactive commands: /help /exit /mode /tree /agents /skills /commands /clear
 * plus any prompt template loaded from <cwd>/prompts or ~/.micro-harness/prompts.
 */

import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Harness, type ApprovalMode, type ConfirmFn } from './harness.ts'
import { openaiProvider } from './provider.ts'
import { EventHub, buildAgentTree, formatAgentTree, type TaggedEvent } from './events.ts'
import { Trace } from './trace.ts'
import { makeTools } from './tools.ts'
import { AgentRunner, createAgentRegistry, loadAgentRoles, makeTaskTool } from './agents.ts'
import { Renderer } from './tui.ts'
import { expandTemplate, loadPromptTemplates, loadSkills, skillsToPrompt, type PromptTemplate, type Skill } from './commands.ts'
import { parseTaskFile, runAuto } from './autorun.ts'

// ------------------------------------------------------------------- argv

const VALUE_FLAGS = new Set([
  'dir', 'model', 'max-steps', 'max-context', 'base-url', 'approval', 'max-depth', 'max-concurrency',
  'agent-timeout', 'agent-max-tokens', 'agent-max-cost', 'price-input', 'price-output', 'session',
  'tasks', 'max-iterations', 'max-cost', 'max-tokens', 'timeout', 'role', 'system',
])

const argv = process.argv.slice(2)
const positionals: string[] = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]!
  if (arg.startsWith('--')) {
    const [name, inline] = arg.slice(2).split('=', 2)
    if (inline === undefined && VALUE_FLAGS.has(name!)) i++
    continue
  }
  positionals.push(arg)
}

function flag(name: string): boolean {
  return argv.includes(`--${name}`)
}

function opt(name: string, fallback?: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  if (i !== -1 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) return argv[i + 1]
  return fallback
}

const sub = positionals[0] === 'run' ? 'run' : 'chat'
const args = sub === 'run' ? positionals.slice(1) : positionals

const quiet = flag('quiet')
const allowBash = flag('allow-bash')
const traceOn = flag('trace')
const autoMode = flag('auto')
const yes = flag('yes')
const cwd = path.resolve(opt('dir', process.cwd())!)
const maxSteps = Number(opt('max-steps', '24')) || 24
const maxContextTokens = Number(opt('max-context', '24000')) || 24_000
const model = opt('model', process.env.MICRO_MODEL || process.env.OPENAI_MODEL || 'deepseek-chat')!
const baseUrl = opt('base-url', process.env.MICRO_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com')!
const apiKey = process.env.MICRO_API_KEY || process.env.OPENAI_API_KEY || ''
const approval = (opt('approval', 'full-auto') as ApprovalMode) ?? 'full-auto'
const pricing = {
  input: Number(opt('price-input', process.env.MICRO_PRICE_INPUT || '0')) || 0,
  output: Number(opt('price-output', process.env.MICRO_PRICE_OUTPUT || '0')) || 0,
}

if (!apiKey) {
  console.error('missing API key: set MICRO_API_KEY (or OPENAI_API_KEY)')
  process.exit(1)
}

// ----------------------------------------------------------------- skills

function loadAllSkills(): Skill[] {
  const dirs = [path.join(cwd, 'skills'), path.join(os.homedir(), '.micro-harness', 'skills')]
  return dirs.flatMap((d) => loadSkills(d))
}

function loadAllTemplates(): PromptTemplate[] {
  const dirs = [
    path.join(cwd, 'prompts'),
    path.join(cwd, 'commands'),
    path.join(os.homedir(), '.micro-harness', 'prompts'),
  ]
  const byName = new Map<string, PromptTemplate>()
  for (const dir of dirs) for (const t of loadPromptTemplates(dir)) byName.set(t.name, t)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

const skills = loadAllSkills()
const templates = loadAllTemplates()
const templateMap = new Map(templates.map((t) => [t.name, t]))
const systemPrompt =
  (opt('system') ?? `You are a careful coding agent working inside the directory ${cwd}.
Use the provided tools to inspect and modify files; prefer reading a file before writing it.
Work autonomously — do not ask for confirmation. When the task is complete, reply with a short summary of what you did.`) +
  skillsToPrompt(skills)

// ------------------------------------------------------------------ wiring

const trace = traceOn ? new Trace(path.join(cwd, 'traces')) : null
const hub = new EventHub()
const recorded: TaggedEvent[] = []
const renderer = quiet ? null : new Renderer({ showThinking: flag('thinking') })
hub.on((e: TaggedEvent) => {
  recorded.push(e)
  trace?.write(e)
  renderer?.onEvent(e)
})

function printAgentTree(): void {
  const roots = buildAgentTree(recorded)
  const multi = roots.some((r) => r.children.length > 0)
  if ((!multi && !flag('tree')) || quiet) return
  renderer?.endStream()
  console.log('\nagent tree:\n' + formatAgentTree(roots))
}

const roleDirs = [path.join(cwd, 'agents'), path.join(os.homedir(), '.micro-harness', 'agents')]
const roles = createAgentRegistry(roleDirs.flatMap((d) => loadAgentRoles(d)))
const provider = openaiProvider({ baseUrl, apiKey })

async function promptConfirm(request: { tool: string; args: unknown }): Promise<boolean> {
  if (yes) return true
  if (!stdin.isTTY) return false
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = await rl.question(`allow ${request.tool} ${JSON.stringify(request.args)}? [y/N] `)
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

const confirm: ConfirmFn | undefined = approval === 'full-auto' ? undefined : (req) => promptConfirm(req)

const runner = new AgentRunner({
  provider,
  model,
  cwd,
  hub,
  roles,
  tools: makeTools(),
  allowBash,
  approval,
  confirm,
  pricing,
  maxDepth: Number(opt('max-depth', '3')) || 3,
  maxConcurrency: Number(opt('max-concurrency', '4')) || 4,
  timeoutMs: (Number(opt('agent-timeout', '300')) || 300) * 1000,
  maxTokens: opt('agent-max-tokens') ? Number(opt('agent-max-tokens')) : undefined,
  maxCost: opt('agent-max-cost') ? Number(opt('agent-max-cost')) : undefined,
})

const harness = new Harness({
  provider,
  model,
  cwd,
  allowBash,
  maxSteps,
  maxContextTokens,
  systemPrompt,
  hub,
  pricing,
  approval,
  confirm,
  tools: [...makeTools(), makeTaskTool(runner)],
})

if (!quiet) {
  console.error(`micro-harness · ${model} · cwd ${cwd} · approval ${approval}${allowBash ? ' · bash on' : ''}`)
}

// ----------------------------------------------------------------- run modes

if (sub === 'run' && autoMode) {
  let tasks = args
  const taskFile = opt('tasks')
  if (taskFile) tasks = parseTaskFile(readFileSync(path.resolve(taskFile), 'utf8'))
  if (!tasks.length) {
    console.error('run --auto needs tasks: pass them as args or via --tasks <file>')
    process.exit(1)
  }
  const result = await runAuto({
    harness,
    tasks,
    maxIterations: opt('max-iterations') ? Number(opt('max-iterations')) : undefined,
    maxCost: opt('max-cost') ? Number(opt('max-cost')) : undefined,
    maxTokens: opt('max-tokens') ? Number(opt('max-tokens')) : undefined,
    timeoutMs: opt('timeout') ? Number(opt('timeout')) * 1000 : undefined,
    onIteration: ({ index, task, result }) => {
      if (!quiet) console.error(`\n── auto ${index + 1}/${tasks.length}: ${task.slice(0, 80)}\n${result}`)
    },
  })
  printAgentTree()
  console.log(
    `\nauto-run ${result.stopReason} · ${result.iterations}/${tasks.length} tasks · ${result.tokens} tok` +
      (result.cost ? ` · $${result.cost.toFixed(6)}` : ''),
  )
  process.exit(result.stopReason === 'completed' ? 0 : 1)
}

if (args.length) {
  const prompt = args.join(' ').trim()
  await harness.send(prompt)
  renderer?.endStream()
  if (quiet) console.log(await lastAnswer())
  printAgentTree()
  process.exit(0)
}

// ------------------------------------------------------------- interactive

async function lastAnswer(): Promise<string> {
  // `send` already returned the text; capture it via the event stream.
  const ends = recorded.filter((e) => e.event.type === 'turn.end')
  const last = ends[ends.length - 1]
  return last && last.event.type === 'turn.end' ? last.event.text : ''
}

const rl = createInterface({ input: stdin, output: stdout })
console.log('interactive mode — type a task, /help for commands, /exit to quit.\n')

function printHelp(): void {
  console.log(
    [
      'commands:',
      '  /help                 show this help',
      '  /exit, /quit          leave',
      '  /mode <m>             set permission mode (suggest | auto-edit | full-auto)',
      '  /tree                 print the agent tree',
      '  /agents               list agent roles',
      '  /skills               list loaded skills',
      '  /commands             list prompt templates',
      '  /clear                clear this conversation (new harness)',
      `  /<template> [args]    ${templates.map((t) => t.name).join(', ') || '(no templates loaded)'}`,
    ].join('\n'),
  )
}

for (;;) {
  const line = (await rl.question('› ')).trim()
  if (!line) continue
  if (!line.startsWith('/')) {
    await harness.send(line)
    renderer?.endStream()
    printAgentTree()
    continue
  }

  const [rawName, ...rest] = line.slice(1).split(/\s+/)
  const name = rawName ?? ''
  const template = templateMap.get(name)
  if (template) {
    const expanded = expandTemplate(template, rest)
    await harness.send(expanded)
    renderer?.endStream()
    printAgentTree()
    continue
  }

  switch (name) {
    case 'exit':
    case 'quit':
      rl.close()
      process.exit(0)
    case 'help':
      printHelp()
      break
    case 'tree':
      console.log(formatAgentTree(buildAgentTree(recorded)))
      break
    case 'agents':
      console.log(roles.list().join('\n'))
      break
    case 'skills':
      console.log(skills.length ? skills.map((s) => `${s.name}${s.description ? ` — ${s.description}` : ''}`).join('\n') : '(none)')
      break
    case 'commands':
      console.log(templates.length ? templates.map((t) => `${t.name}${t.description ? ` — ${t.description}` : ''}`).join('\n') : '(none)')
      break
    case 'mode': {
      const mode = rest[0]
      if (mode === 'suggest' || mode === 'auto-edit' || mode === 'full-auto') {
        console.log(`permission mode is a startup flag; restart with --approval ${mode}`)
      } else {
        console.log('usage: /mode <suggest|auto-edit|full-auto>')
      }
      break
    }
    case 'clear':
      console.log('(start a fresh process to clear context)')
      break
    default:
      console.log(`unknown command: /${name} — try /help`)
  }
}
