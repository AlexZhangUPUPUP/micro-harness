import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AgentRunner, createAgentRegistry } from '../src/agents.ts'
import { EventHub } from '../src/events.ts'

/** 创建只用于隔离失败验证的运行器，记录任何意外模型调用。 */
function isolatedRunner(cwd: string) {
  let modelCalls = 0
  let toolCalls = 0
  const runner = new AgentRunner({
    cwd, model: 'test', hub: new EventHub(), roles: createAgentRegistry(),
    isolation: 'worktree', maxConcurrency: 1,
    provider: { name: 'test', async chat() {
      // 失败场景不应进入模型循环，故返回可观测的工具调用。
      modelCalls++
      return { message: { role: 'assistant', content: null, tool_calls: [
        { id: 'write', function: { name: 'write_probe', arguments: '{}' } },
      ] } }
    } },
    tools: [{ name: 'write_probe', description: 'probe', parameters: { type: 'object' },
      async run() {
        // 工具计数证明未退回共享工作区执行。
        toolCalls++
        return { output: 'unexpected' }
      } }],
  })
  return { runner, calls: () => ({ modelCalls, toolCalls }) }
}

/** 使用真实 Git 命令建立确定性的测试前置条件。 */
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })
}

// 覆盖非仓库、无提交仓库和 worktree 创建失败，且不使用全局模块 mock。
for (const scenario of ['not-repository', 'empty-repository', 'creation-failure'] as const) {
  test(`worktree isolation refuses ${scenario} and releases queued tasks`, async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'mh-isolation-failure-'))
    try {
      // Git 元数据只写入临时仓库；用普通文件阻止创建 worktrees 目录。
      if (scenario !== 'not-repository') git(cwd, 'init')
      if (scenario === 'creation-failure') {
        git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial')
        await writeFile(path.join(cwd, '.git', 'worktrees'), 'blocked')
      }
      const { runner, calls } = isolatedRunner(cwd)
      // 同时排队两个任务，验证初始化失败不会占住唯一并发名额。
      const results = await Promise.all([
        runner.run('agent', 'first', 'main', 0), runner.run('agent', 'second', 'main', 0),
      ])
      for (const result of results) {
        expect(result.ok).toBe(false)
        expect(result.error).toContain(scenario === 'creation-failure' ? 'worktree isolation failed' : 'worktree isolation requires')
        expect(result.input + result.output + result.cost).toBe(0)
      }
      expect(calls()).toEqual({ modelCalls: 0, toolCalls: 0 })
      expect(runner.active).toBe(0)
      expect(runner.worktrees().size).toBe(0)
    } finally {
      // 即使断言失败也删除临时仓库，避免残留测试数据。
      await rm(cwd, { recursive: true, force: true })
    }
  })
}
