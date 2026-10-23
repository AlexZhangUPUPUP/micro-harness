#!/usr/bin/env bun
/**
 * A minimal MCP server over stdio, used as a test fixture: initialize → tools/list →
 * tools/call, newline-delimited JSON-RPC. Deliberately hand-rolled so the test
 * exercises the client against the wire protocol, not against an SDK.
 */
let buffer = ''
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'boom',
    description: 'Always fails',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'peek',
    description: 'Read-only inspection',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'slow',
    description: 'Waits before replying',
    inputSchema: { type: 'object', properties: {} },
  },
]

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let nl = buffer.indexOf('\n')
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    nl = buffer.indexOf('\n')
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }

    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-mcp', version: '0.0.1' },
        },
      })
    } else if (msg.method === 'notifications/initialized') {
      // notification: no reply
    } else if (msg.method === 'tools/list') {
      // two pages would be sent here if we wanted to test cursor following
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params
      if (name === 'echo') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo:${args.text}` }] } })
      } else if (name === 'peek') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'peeked' }] } })
      } else if (name === 'boom') {
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'kaboom' }], isError: true } })
      } else if (name === 'slow') {
        // 模拟不可安全复用的长调用，测试取消时进程组是否被终止。
        setTimeout(() => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'late' }] } }), 5000)
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool: ${name}` } })
      }
    } else if (msg.id !== undefined) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
    }
  }
})
