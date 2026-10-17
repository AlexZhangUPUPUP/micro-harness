import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makeTools, type ChatMessage, type Provider, type Tool } from '@micro-harness/core'
import { createServer, type HarnessServer, type PermissionPreset } from '../src/server.ts'
import { SessionStore } from '../src/store.ts'

/** 构造模型工具调用，不依赖真实模型或联网服务。 */
function toolCall(name: string, args: Record<string, unknown> = {}): ChatMessage {
  return {
    role: 'assistant', content: null,
    tool_calls: [{ id: `call-${name}`, function: { name, arguments: JSON.stringify(args) } }],
  }
}

/** 创建会修改临时文件的外部工具，观察权限是否真正阻止执行。 */
function externalWrite(): Tool {
  return {
    name: 'external__write', description: '写入测试文件', mutating: true,
    parameters: { type: 'object', properties: {} },
    // 使用真实临时文件区分工具被隐藏与副作用被阻止。
    async run(_args, ctx) {
      writeFileSync(path.join(ctx.cwd, 'external.txt'), 'changed')
      return { output: 'changed' }
    },
  }
}

/** 构造明确声明只读的外部工具，避免修复误伤正常读取。 */
function externalRead(): Tool {
  return {
    name: 'external__read', description: '读取测试标记', mutating: false,
    parameters: { type: 'object', properties: {} },
    async run() { return { output: 'read-marker' } },
  }
}

/** 启动真实 HTTP 服务，用脚本化模型观察主 Agent 和子 Agent 的工具集合。 */
function boot(permission: PermissionPreset, requested = 'external__write', delegate = false) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-permission-boundary-'))
  const store = new SessionStore(dir)
  const seen: string[][] = []
  const provider: Provider = {
    name: 'permission-probe',
    async chat(req) {
      seen.push(req.tools.map((tool) => tool.function.name))
      // 每个上下文只发起一次调用，收到工具结果后结束。
      const lastUser = req.messages.findLastIndex((message) => message.role === 'user')
      if (req.messages.slice(lastUser + 1).some((message) => message.role === 'tool')) {
        return { message: { role: 'assistant', content: 'done' } }
      }
      // 父 Agent 委派后，子 Agent 仍尝试调用同一个外部工具。
      const prompt = req.messages.find((message) => message.role === 'user')?.content
      const message = delegate && prompt === 'delegate'
        ? toolCall('task', { mode: 'single', prompt: 'child' })
        : toolCall(requested)
      return { message }
    },
  }
  const srv = createServer({
    store, provider, model: 'scripted', cwd: dir, port: 0, permission,
    tools: [...makeTools(), externalWrite(), externalRead()],
  })
  return {
    dir, store, srv, seen,
    // 服务停止后再删除本用例创建的临时文件。
    stop() { srv.stop(true); rmSync(dir, { recursive: true, force: true }) },
  }
}

/** 通过会话接口执行一轮任务，并等待所有工具结果落盘。 */
async function send(srv: HarnessServer, id?: string, prompt = 'attempt') {
  const endpoint = id ? `/api/sessions/${id}/resume` : '/api/sessions'
  const response = await fetch(srv.url + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
  })
  expect(response.status).toBe(id ? 202 : 201)
  const { session } = await response.json() as { session: { id: string } }
  await srv.idle(session.id)
  return session.id
}

// 验证父子 Agent 均无法绕过只读预设执行外部写工具。
for (const delegate of [false, true]) {
  test(`read-only blocks external writes in ${delegate ? 'child' : 'main'} agent`, async () => {
    const h = boot('read-only', 'external__write', delegate)
    try {
      const id = await send(h.srv, undefined, delegate ? 'delegate' : 'attempt')
      expect(h.seen.length).toBeGreaterThanOrEqual(delegate ? 4 : 2)
      for (const names of h.seen) expect(names).not.toContain('external__write')
      expect(existsSync(path.join(h.dir, 'external.txt'))).toBe(false)
      expect(h.store.events(id).some(({ event }) =>
        event.type === 'tool.result' && event.name === 'external__write' && !event.ok,
      )).toBe(true)
    } finally {
      h.stop()
    }
  })
}

// 验证只读模式继续提供非联网的外部读工具。
test('read-only keeps external read tools executable', async () => {
  const h = boot('read-only', 'external__read')
  try {
    const id = await send(h.srv)
    expect(h.seen[0]).toContain('external__read')
    expect(h.store.events(id).some(({ event }) =>
      event.type === 'tool.result' && event.name === 'external__read' && event.ok && event.output === 'read-marker',
    )).toBe(true)
  } finally {
    h.stop()
  }
})

// 保留其他预设下现有的非联网外部写工具行为。
for (const preset of ['workspace', 'full', 'auto-review'] as const) {
  test(`${preset} preserves external write tools`, async () => {
    const h = boot(preset)
    try {
      await send(h.srv)
      expect(h.seen[0]).toContain('external__write')
      expect(existsSync(path.join(h.dir, 'external.txt'))).toBe(true)
    } finally {
      h.stop()
    }
  })
}

// 验证会话从 full 切换到只读后，后续运行重新过滤工具。
test('resuming a read-only session removes previously available external writes', async () => {
  const h = boot('full')
  try {
    const id = await send(h.srv)
    const before = h.store.events(id).filter(({ event }) => event.type === 'tool.result' && event.name === 'external__write').length
    const response = await fetch(`${h.srv.url}/api/sessions/${id}/permission`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preset: 'read-only' }),
    })
    expect(response.status).toBe(200)
    // 删除上一轮标记，确认本轮不会再次产生副作用。
    rmSync(path.join(h.dir, 'external.txt'))
    await send(h.srv, id)
    expect(h.seen.at(-1)).not.toContain('external__write')
    const results = h.store.events(id).filter(({ event }) => event.type === 'tool.result' && event.name === 'external__write')
    expect(results).toHaveLength(before + 1)
    expect(results.at(-1)?.event).toMatchObject({ ok: false })
    expect(existsSync(path.join(h.dir, 'external.txt'))).toBe(false)
  } finally {
    h.stop()
  }
})
