import { test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { ACP_PROTOCOL_VERSION, runAcpServer } from '../src/acp.ts'
import type { ChatResponse, Provider } from '../src/provider.ts'
import type { ChatMessage } from '../src/model.ts'

const assistantTool = (id: string, name: string, args: unknown): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
})

const scripted = (responses: ChatResponse[]): Provider => {
  let i = 0
  return {
    name: 'fake',
    async chat() {
      return responses[Math.min(i++, responses.length - 1)]!
    },
  }
}

/** A client that speaks ACP to the server over in-memory streams. */
function acpClient(provider: Provider, opts: { approval?: 'suggest' | 'full-auto'; clientCapabilities?: unknown } = {}) {
  const toAgent = new PassThrough()
  const fromAgent = new PassThrough()
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  const notifications: any[] = []
  const clientRequests: Array<{ method: string; params: any }> = []
  let reply: (method: string, params: any) => unknown = () => ({})
  let nextId = 0
  let buffer = ''

  const write = (msg: unknown): void => void toAgent.write(JSON.stringify(msg) + '\n')

  fromAgent.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
      if (!line) continue
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: any; result?: any; error?: any }
      if (msg.id !== undefined && msg.method === undefined) {
        const waiter = pending.get(msg.id)
        if (waiter) {
          pending.delete(msg.id)
          if (msg.error) waiter.reject(new Error(msg.error.message))
          else waiter.resolve(msg.result)
        }
      } else if (msg.method && msg.id !== undefined) {
        clientRequests.push({ method: msg.method, params: msg.params })
        const result = reply(msg.method, msg.params)
        write(result === undefined ? { id: msg.id, error: { code: -32601, message: 'no handler' } } : { id: msg.id, result })
      } else if (msg.method) {
        notifications.push({ method: msg.method, params: msg.params })
      }
    }
  })

  const started = runAcpServer({
    provider,
    model: 'fake-model',
    cwd: process.cwd(),
    approval: opts.approval ?? 'full-auto',
    input: toAgent,
    output: fromAgent,
    log: () => {},
  })

  return {
    notifications,
    clientRequests,
    onClientRequest: (fn: (method: string, params: any) => unknown) => {
      reply = fn
    },
    request<T = any>(method: string, params?: unknown): Promise<T> {
      const id = ++nextId
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        write({ jsonrpc: '2.0', id, method, params })
      })
    },
    notify(method: string, params?: unknown): void {
      write({ jsonrpc: '2.0', method, params })
    },
    updates: () => notifications.filter((n) => n.method === 'session/update').map((n) => n.params.update),
    close: async () => {
      toAgent.end()
      await started
    },
    started,
  }
}

const tmp = (): string => mkdtempSync(path.join(tmpdir(), 'mh-acp-'))

test('initialize answers with protocol version 1 and identifies itself', async () => {
  const c = acpClient(scripted([{ message: { role: 'assistant', content: 'ok' } }]), {
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  })
  const res = await c.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: 'test-editor', version: '1' },
  })
  expect(res.protocolVersion).toBe(ACP_PROTOCOL_VERSION)
  expect(res.agentInfo.name).toBe('micro-harness')
  expect(res.agentCapabilities.promptCapabilities.embeddedContext).toBe(true)
  await c.close()
})

test('session/new then session/prompt streams tool calls and writes the file', async () => {
  const dir = tmp()
  try {
    const c = acpClient(
      scripted([
        { message: assistantTool('c1', 'write_file', { path: 'out.txt', content: 'from acp\n' }) },
        { message: { role: 'assistant', content: 'wrote it' } },
        { message: { role: 'assistant', content: 'wrote it' } },
      ]),
    )
    await c.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await c.request('session/new', { cwd: dir, mcpServers: [] })
    expect(typeof sessionId).toBe('string')

    const res = await c.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'create out.txt' }],
    })
    expect(res.stopReason).toBe('end_turn')

    // the assistant's text arrives as a chunk notification
    const chunks = c.updates().filter((u) => u.sessionUpdate === 'agent_message_chunk')
    expect(chunks.length).toBeGreaterThan(0)

    // the tool call is announced and then updated to completed
    const call = c.updates().find((u) => u.sessionUpdate === 'tool_call')
    expect(call.toolCallId).toBe('c1')
    expect(call.kind).toBe('edit')
    expect(call.status).toBe('in_progress')
    expect(call.rawInput).toEqual({ path: 'out.txt', content: 'from acp\n' })
    const done = c.updates().find((u) => u.sessionUpdate === 'tool_call_update')
    expect(done.status).toBe('completed')

    // ...and it really happened
    expect(readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('from acp\n')
    await c.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('approvals are routed to the editor through session/request_permission', async () => {
  const dir = tmp()
  try {
    const c = acpClient(
      scripted([
        { message: assistantTool('c1', 'write_file', { path: 'guarded.txt', content: 'ok\n' }) },
        { message: { role: 'assistant', content: 'done' } },
        { message: { role: 'assistant', content: 'done' } },
      ]),
      { approval: 'suggest' },
    )
    let asked: any = null
    c.onClientRequest((method, params) => {
      if (method === 'session/request_permission') {
        asked = params
        return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
      }
      return undefined
    })
    await c.request('initialize', { protocolVersion: 1 })
    const { sessionId } = await c.request('session/new', { cwd: dir, mcpServers: [] })
    await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write guarded.txt' }] })

    expect(asked).not.toBeNull()
    expect(asked.toolCall.title).toBe('write_file')
    expect(asked.options.map((o: any) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once', 'reject_always'])
    expect(existsSync(path.join(dir, 'guarded.txt'))).toBe(true)
    await c.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rejected permission stops the tool from running', async () => {
  const dir = tmp()
  try {
    const c = acpClient(
      scripted([
        { message: assistantTool('c1', 'write_file', { path: 'nope.txt', content: 'x' }) },
        { message: { role: 'assistant', content: 'ok' } },
        { message: { role: 'assistant', content: 'ok' } },
      ]),
      { approval: 'suggest' },
    )
    c.onClientRequest((method) => (method === 'session/request_permission' ? { outcome: { outcome: 'selected', optionId: 'reject-once' } } : undefined))
    await c.request('initialize', { protocolVersion: 1 })
    const { sessionId } = await c.request('session/new', { cwd: dir, mcpServers: [] })
    await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'write nope.txt' }] })

    expect(existsSync(path.join(dir, 'nope.txt'))).toBe(false)
    const failed = c.updates().find((u) => u.sessionUpdate === 'tool_call_update')
    expect(failed.status).toBe('failed')
    await c.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the client's filesystem becomes the FileSystem provider when advertised", async () => {
  const dir = tmp()
  try {
    // The harness will be told to read a file that exists ONLY in the editor's buffer.
    const c = acpClient(
      scripted([
        { message: assistantTool('c1', 'read_file', { path: 'buffer.txt' }) },
        { message: { role: 'assistant', content: 'read it' } },
        { message: { role: 'assistant', content: 'read it' } },
      ]),
    )
    c.onClientRequest((method, params) => {
      if (method === 'fs/read_text_file') {
        expect(params.path).toBe(path.join(dir, 'buffer.txt'))
        return { content: 'CONTENT FROM THE EDITOR BUFFER\n' }
      }
      return undefined
    })
    await c.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    })
    const { sessionId } = await c.request('session/new', { cwd: dir, mcpServers: [] })
    await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'read buffer.txt' }] })

    // the read really went through the client, not the disk
    expect(c.clientRequests.map((r) => r.method)).toContain('fs/read_text_file')
    const result = c.updates().find((u) => u.sessionUpdate === 'tool_call_update')
    expect(result.status).toBe('completed')
    expect(JSON.stringify(result.content)).toContain('CONTENT FROM THE EDITOR BUFFER')
    // ...and the file genuinely does not exist on disk
    expect(existsSync(path.join(dir, 'buffer.txt'))).toBe(false)
    await c.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('without the fs capability, reads come from local disk', async () => {
  const dir = tmp()
  try {
    writeFileSync(path.join(dir, 'on-disk.txt'), 'FROM DISK\n')
    const c = acpClient(
      scripted([
        { message: assistantTool('c1', 'read_file', { path: 'on-disk.txt' }) },
        { message: { role: 'assistant', content: 'read it' } },
        { message: { role: 'assistant', content: 'read it' } },
      ]),
    )
    c.onClientRequest((method) => (method === 'fs/read_text_file' ? { content: 'WRONG' } : undefined))
    await c.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await c.request('session/new', { cwd: dir, mcpServers: [] })
    await c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'read on-disk.txt' }] })

    expect(c.clientRequests.map((r) => r.method)).not.toContain('fs/read_text_file')
    const result = c.updates().find((u) => u.sessionUpdate === 'tool_call_update')
    expect(JSON.stringify(result.content)).toContain('FROM DISK')
    await c.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('session/cancel aborts the turn and answers cancelled', async () => {
  const dir = tmp()
  try {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const provider: Provider = {
      name: 'slow',
      async chat() {
        await gate
        return { message: { role: 'assistant', content: 'too late' } }
      },
    }
    const c = acpClient(provider)
    await c.request('initialize', { protocolVersion: 1 })
    const { sessionId } = await c.request('session/new', { cwd: dir, mcpServers: [] })

    const prompting = c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'slow one' }] })
    await new Promise((r) => setTimeout(r, 50))
    c.notify('session/cancel', { sessionId })
    release()
    const res = await prompting
    expect(res.stopReason).toBe('cancelled')
    await c.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unknown methods and sessions are rejected with JSON-RPC errors', async () => {
  const c = acpClient(scripted([{ message: { role: 'assistant', content: 'x' } }]))
  await c.request('initialize', { protocolVersion: 1 })
  await expect(c.request('session/nope', {})).rejects.toThrow(/method not found/)
  await expect(c.request('session/prompt', { sessionId: 'missing', prompt: [] })).rejects.toThrow(/unknown session/)
  await c.close()
})
