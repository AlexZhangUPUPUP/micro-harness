import { test, expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AgentRunner,
  EventHub,
  createAgentRegistry,
  createWorktree,
  integrateApply,
  integratePreview,
  inspectWorktrees,
  isGitRepo,
  promoteWorktree,
  removeWorktree,
  worktreeDiff,
  type Provider,
} from '../src/index.ts'

function gitRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-wt-'))
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(path.join(dir, 'base.txt'), 'base\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return dir
}

test('worktree inspection reports clean and dirty lifecycle states', () => {
  const repo = gitRepo()
  const wt = createWorktree({ cwd: repo, taskId: 'inspect', agentId: 'a1' })
  try {
    const clean = inspectWorktrees(repo)
    expect(clean.length).toBeGreaterThan(0)
    writeFileSync(path.join(wt.path, 'uncommitted.txt'), 'pending\n')
    const dirty = inspectWorktrees(repo).find((item) => item.path.endsWith(path.basename(wt.path)))
    expect(dirty?.status).toBe('dirty')
  } finally {
    removeWorktree({ cwd: repo, path: wt.path, branch: wt.branch })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('worktree: create, diff, promote and remove', () => {
  const repo = gitRepo()
  const wt = createWorktree({ cwd: repo, taskId: 't1', agentId: 'a1' })
  try {
    expect(isGitRepo(repo)).toBe(true)
    expect(existsSync(wt.path)).toBe(true)
    expect(wt.branch).toContain('a1')

    writeFileSync(path.join(wt.path, 'agent.txt'), 'from the agent\n')
    const diff = worktreeDiff(wt.path)
    expect(diff.files.map((f) => f.path)).toContain('agent.txt')
    expect(diff.diff).toContain('from the agent')

    // isolated: the shared workspace does not change until we promote
    expect(existsSync(path.join(repo, 'agent.txt'))).toBe(false)
    const promoted = promoteWorktree({ worktree: wt.path, cwd: repo })
    expect(promoted.ok).toBe(true)
    expect(promoted.applied).toContain('agent.txt')
    expect(existsSync(path.join(repo, 'agent.txt'))).toBe(true)
  } finally {
    removeWorktree({ cwd: repo, path: wt.path, branch: wt.branch })
    expect(existsSync(wt.path)).toBe(false)
    rmSync(repo, { recursive: true, force: true })
  }
})

test('merge queue: clean changes from two agents integrate in one pass', () => {
  const repo = gitRepo()
  const a = createWorktree({ cwd: repo, taskId: 't2', agentId: 'a1' })
  const b = createWorktree({ cwd: repo, taskId: 't2', agentId: 'a2' })
  try {
    writeFileSync(path.join(a.path, 'one.txt'), 'one\n')
    writeFileSync(path.join(b.path, 'two.txt'), 'two\n')

    const preview = integratePreview({
      cwd: repo,
      agents: [
        { agentId: 'a1', worktree: a.path, base: a.base },
        { agentId: 'a2', worktree: b.path, base: b.base },
      ],
    })
    expect(preview.files.map((f) => f.path).sort()).toEqual(['one.txt', 'two.txt'])
    expect(preview.files.every((f) => f.clean)).toBe(true)

    const applied = integrateApply({
      cwd: repo,
      worktrees: { a1: a.path, a2: b.path },
      files: preview.files.map((f) => ({ path: f.path, content: f.content ?? '' })),
    })
    expect(applied.applied.sort()).toEqual(['one.txt', 'two.txt'])
    expect(existsSync(path.join(repo, 'one.txt'))).toBe(true)
    expect(existsSync(path.join(repo, 'two.txt'))).toBe(true)
  } finally {
    removeWorktree({ cwd: repo, path: a.path, branch: a.branch })
    removeWorktree({ cwd: repo, path: b.path, branch: b.branch })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('merge queue: two agents editing the same file surface a conflict', () => {
  const repo = gitRepo()
  const a = createWorktree({ cwd: repo, taskId: 't3', agentId: 'a1' })
  const b = createWorktree({ cwd: repo, taskId: 't3', agentId: 'a2' })
  try {
    writeFileSync(path.join(a.path, 'same.txt'), 'A\nMAIN\nC\n')
    writeFileSync(path.join(b.path, 'same.txt'), 'A\nOTHER\nC\n')

    const preview = integratePreview({
      cwd: repo,
      agents: [
        { agentId: 'a1', worktree: a.path, base: a.base },
        { agentId: 'a2', worktree: b.path, base: b.base },
      ],
    })
    const file = preview.files.find((f) => f.path === 'same.txt')
    expect(file?.clean).toBe(false)
    expect(file?.agents).toContain('a1')
    expect(file?.blocks?.some((bl) => bl.type === 'conflict')).toBe(true)
  } finally {
    removeWorktree({ cwd: repo, path: a.path, branch: a.branch })
    removeWorktree({ cwd: repo, path: b.path, branch: b.branch })
    rmSync(repo, { recursive: true, force: true })
  }
})

test('runner: isolation gives each agent its own worktree (and is cleanable)', async () => {
  const repo = gitRepo()
  const hub = new EventHub()
  const events: Array<{ agentId: string; type: string }> = []
  hub.on((e) => events.push({ agentId: e.agentId, type: e.event.type }))

  let turn = 0
  const provider: Provider = {
    name: 'scripted',
    async chat(req) {
      const hasToolResult = req.messages.some((m) => m.role === 'tool')
      if (!hasToolResult) {
        turn++
        return {
          message: {
            role: 'assistant',
            content: 'writing',
            tool_calls: [
              { id: `c${turn}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: `out-${turn}.txt`, content: 'x\n' }) } },
            ],
          },
        }
      }
      return { message: { role: 'assistant', content: 'written' } }
    },
  }

  const runner = new AgentRunner({
    provider,
    model: 'fake',
    cwd: repo,
    hub,
    roles: createAgentRegistry([{ name: 'worker' }]),
    tools: (await import('../src/tools.ts')).makeTools(),
    isolation: 'worktree',
    maxConcurrency: 2,
    taskId: 't4',
  })

  try {
    const a = await runner.run('worker', 'write a file', 'main', 0)
    const b = await runner.run('worker', 'write another file', 'main', 0)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    expect(a.worktree?.path).toBeTruthy()
    expect(b.worktree?.path).toBeTruthy()
    expect(a.worktree!.path).not.toBe(b.worktree!.path)

    // each agent's file landed in its OWN worktree, never in the shared repo
    expect(existsSync(path.join(a.worktree!.path, 'out-1.txt'))).toBe(true)
    expect(existsSync(path.join(b.worktree!.path, 'out-2.txt'))).toBe(true)
    expect(existsSync(path.join(repo, 'out-1.txt'))).toBe(false)
    expect(existsSync(path.join(repo, 'out-2.txt'))).toBe(false)

    // the worktree is observable in the event stream (so UIs can show it)
    expect(events.some((e) => e.type === 'agent.worktree' && e.agentId !== 'main')).toBe(true)

    const removed = runner.cleanupWorktrees()
    expect(removed).toBe(2)
    expect(existsSync(a.worktree!.path)).toBe(false)
  } finally {
    runner.cleanupWorktrees()
    rmSync(repo, { recursive: true, force: true })
  }
})
