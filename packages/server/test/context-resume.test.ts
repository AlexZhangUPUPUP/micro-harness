import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ChatMessage, Provider, Tool } from '@micro-harness/core'
import { createServer, type HarnessServer } from '../src/server.ts'
import { SessionStore } from '../src/store.ts'

/** 通过真实 HTTP 接口创建或恢复会话，并等待本轮持久化完成。 */
async function send(server: HarnessServer, prompt: string, id?: string): Promise<string> {
  const endpoint = id ? `/api/sessions/${id}/resume` : '/api/sessions'
  const response = await fetch(server.url + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
  })
  expect(response.status).toBe(id ? 202 : 201)
  const { session } = await response.json() as { session: { id: string } }
  await server.idle(session.id)
  return session.id
}

/** 启动同一数据目录上的新实例，模拟服务进程重启。 */
function boot(dir: string, provider: Provider, systemPrompt: string, tools: Tool[] = []) {
  const store = new SessionStore(dir)
  const server = createServer({
    store, provider, model: 'context-probe', cwd: dir, port: 0,
    systemPrompt, tools, maxToolOutput: 40,
  })
  return { store, server }
}

// 检查点之外的旧对话不能因为服务重启而重新进入模型窗口。
test('new server resumes the persisted checkpoint with current system instructions', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-context-restart-'))
  const seen: ChatMessage[][] = []
  const provider: Provider = {
    name: 'context-probe',
    // 捕获实际提供方请求，验证恢复后的模型输入。
    async chat(req) {
      seen.push(structuredClone(req.messages))
      return { message: { role: 'assistant', content: 'reply' } }
    },
  }
  let h = boot(dir, provider, 'old system')
  try {
    const id = await send(h.server, 'discarded historical request')
    const events = h.store.events(id)
    // 模拟压缩后落盘的精简窗口，旧完整日志仍然保留。
    h.store.append(id, {
      agentId: 'main', parentId: null, seq: Math.max(...events.map((event) => event.seq)) + 1,
      t: Date.now(), event: { type: 'context.checkpoint', checkpoint: {
        version: 1, maxToolOutput: 40, messages: [
          { role: 'system', content: 'old system' },
          { role: 'user', content: 'retained summary' },
          { role: 'assistant', content: 'retained answer' },
        ],
      } },
    })
    h.server.stop(true)
    h = boot(dir, provider, 'new system')
    await send(h.server, 'continue', id)
    const restored = seen.at(-1)!
    expect(restored[0]).toEqual({ role: 'system', content: 'new system' })
    expect(restored.some((message) => message.content === 'retained summary')).toBe(true)
    expect(restored.some((message) => message.content === 'discarded historical request')).toBe(false)
    expect(restored.at(-1)?.content).toBe('continue')
  } finally {
    // 清理最后一个实例及其独占临时目录。
    h.server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})

// 恢复后的旧工具结果必须与重启前实际发送的截断结果完全一致。
test('new server preserves the exact capped tool output when resuming', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mh-context-tool-'))
  const seen: ChatMessage[][] = []
  const provider: Provider = {
    name: 'context-tool-probe',
    // 首次调用工具，之后直接返回，避免续聊发起额外工具调用。
    async chat(req) {
      seen.push(structuredClone(req.messages))
      const message: ChatMessage = seen.length === 1 ? {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'long-output', function: { name: 'read_probe', arguments: '{}' } }],
      } : { role: 'assistant', content: 'done' }
      return { message }
    },
  }
  const tool: Tool = {
    name: 'read_probe', description: '读取测试文本', mutating: false,
    parameters: { type: 'object', properties: {} },
    // 原始结果远大于配置上限，必须经过上下文截断。
    async run() { return { output: '0123456789'.repeat(100) } },
  }
  let h = boot(dir, provider, 'system', [tool])
  try {
    const id = await send(h.server, 'read', undefined)
    const capped = seen.at(-1)!.find((message) => message.role === 'tool')!.content
    expect(String(capped)).toContain('characters elided')
    expect(h.store.events(id).some((event) => event.event.type === 'context.checkpoint')).toBe(true)
    h.server.stop(true)
    h = boot(dir, provider, 'system', [tool])
    await send(h.server, 'continue', id)
    expect(seen.at(-1)!.find((message) => message.role === 'tool')?.content).toBe(capped)
  } finally {
    // 关闭数据库后再删除测试文件。
    h.server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
})
