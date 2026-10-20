/**
 * ACP server — the mirror of the MCP client.
 *
 *   MCP: we call **out** to other people's tools.
 *   ACP: an editor calls **in** to us, driving our harness over stdio.
 *
 * Wire protocol: JSON-RPC 2.0, newline-delimited, over stdin/stdout (the framing the
 * official ACP TypeScript SDK also uses). We implement the agent side:
 *
 *   in   initialize · session/new · session/prompt · session/cancel
 *   out  session/update (notifications) · session/request_permission
 *        fs/read_text_file · fs/write_text_file  (only when the client advertises them)
 *
 * Two things here are worth pointing at:
 *   - approvals are routed to the *editor's* UI through `session/request_permission`,
 *     so `--approval suggest` finally has a place to ask;
 *   - if the client offers its filesystem, we use it as a `FileSystem` **provider** —
 *     the seam from `fs.ts` — so we see the editor's unsaved buffers. ACP has no
 *     directory-listing primitive, so `list` stays on local disk.
 *
 * Protocol version 1. Schema: github.com/zed-industries/agent-client-protocol
 */

import { randomUUID } from 'node:crypto'
import { EventHub, type AgentEvent } from './events.ts'
import { localFs, type DirEntry, type FileSystem } from './fs.ts'
import type { Sandbox } from './sandbox.ts'
import { Harness, type ApprovalMode } from './harness.ts'
import type { Provider } from './provider.ts'
import type { Tool } from './tools.ts'

export const ACP_PROTOCOL_VERSION = 1

export interface AcpOptions {
  provider: Provider
  model: string
  cwd: string
  allowBash?: boolean
  /** OS-level confinement for the shell tool, when configured. */
  sandbox?: Sandbox
  /** Whether a sandboxed shell may reach the network. */
  network?: boolean
  /** non-`full-auto` modes ask the editor through `session/request_permission`. */
  approval?: ApprovalMode
  maxSteps?: number
  pricing?: { input: number; output: number; inputCached?: number }
  tools?: Tool[]
  systemPrompt?: string
  version?: string
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  /** Where to log diagnostics; ACP owns stdout, so anything chatty must go here. */
  log?: (line: string) => void
}

interface RpcMessage {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

const KIND: Record<string, string> = {
  read_file: 'read',
  list_dir: 'read',
  write_file: 'edit',
  bash: 'execute',
  task: 'other',
}

const kindOf = (tool: string): string => KIND[tool] ?? (tool.includes('__') ? 'other' : 'other')

/** Flatten an ACP prompt (an array of content blocks) to text. */
function promptText(prompt: unknown): string {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''
  return prompt
    .map((block) => {
      const b = block as { type?: string; text?: string; uri?: string; name?: string; resource?: { text?: string } }
      if (b.type === 'text') return b.text ?? ''
      if (b.type === 'resource_link') return `[${b.name ?? 'resource'}](${b.uri ?? ''})`
      if (b.type === 'resource') return b.resource?.text ?? ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

interface Session {
  id: string
  harness: Harness
  cwd: string
  hub: EventHub
  controller: AbortController | null
  /** Tools the user said "always allow" / "always reject" for. */
  allowAlways: Set<string>
  denyAlways: Set<string>
  turn: number
  /** Set by `session/cancel`; the spec requires `cancelled` even if nothing throws. */
  cancelled: boolean
}

/** A duplex JSON-RPC channel: agent-side handlers in, client-bound calls out. */
interface Channel {
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  notify(method: string, params?: unknown): void
  respond(id: number | string, result: unknown): void
  fail(id: number | string, code: number, message: string): void
}

function makeChannel(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  onRequest: (method: string, params: Record<string, unknown>, id: number | string) => void,
  onNotify: (method: string, params: Record<string, unknown>) => void,
  log: (line: string) => void,
): Channel {
  let nextId = 0
  let buffer = ''
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  const write = (msg: RpcMessage): void => {
    output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
  }

  const handle = (msg: RpcMessage): void => {
    // a reply to something we asked the client
    if (msg.id !== undefined && msg.method === undefined) {
      const p = pending.get(Number(msg.id))
      if (!p) return
      pending.delete(Number(msg.id))
      clearTimeout(p.timer)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
      return
    }
    if (msg.id !== undefined && msg.method) onRequest(msg.method, msg.params ?? {}, msg.id)
    else if (msg.method) onNotify(msg.method, msg.params ?? {})
  }

  input.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString()
    let nl = buffer.indexOf('\n')
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
      if (!line) continue
      try {
        handle(JSON.parse(line) as RpcMessage)
      } catch (err) {
        log(`acp: ignoring unparseable line: ${(err as Error).message}`)
      }
    }
  })

  return {
    request<T>(method: string, params?: unknown, timeoutMs = 120_000): Promise<T> {
      const id = ++nextId
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`client did not answer ${method} within ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
        write({ id, method, params: params as Record<string, unknown> })
      })
    },
    notify(method, params) {
      write({ method, params: params as Record<string, unknown> })
    },
    respond(id, result) {
      write({ id, result })
    },
    fail(id, code, message) {
      write({ id, error: { code, message } })
    },
  }
}

/** Map one harness event to the `session/update` the editor expects. */
function sessionUpdate(event: AgentEvent, messageId: string): Record<string, unknown> | null {
  switch (event.type) {
    case 'text.delta':
      return { sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text: event.text } }
    case 'thinking.delta':
      return { sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text: event.text } }
    case 'tool.call':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: event.id,
        title: event.name,
        kind: kindOf(event.name),
        status: 'in_progress',
        rawInput: event.args,
      }
    case 'tool.result':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: event.id,
        status: event.ok ? 'completed' : 'failed',
        rawOutput: { output: event.output, ms: event.ms },
        content: [{ type: 'content', content: { type: 'text', text: event.output.slice(0, 4000) } }],
      }
    case 'usage':
      return {
        sessionUpdate: 'usage_update',
        used: event.input + event.output,
        size: 0,
        ...(event.cost !== undefined ? { cost: { amount: event.cost, currency: 'USD' } } : {}),
      }
    default:
      return null
  }
}

/**
 * Serve ACP on stdio until the client closes the stream.
 *
 * Resolves when stdin ends — i.e. the editor went away.
 */
export async function runAcpServer(opts: AcpOptions): Promise<void> {
  const input = opts.input ?? process.stdin
  const output = opts.output ?? process.stdout
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'))
  const sessions = new Map<string, Session>()
  let clientFs: { readTextFile?: boolean; writeTextFile?: boolean } | undefined

  const send = (session: Session, update: Record<string, unknown>): void => {
    channel.notify('session/update', { sessionId: session.id, update })
  }

  /** Approvals go to the editor's UI — this is what `--approval suggest` was missing. */
  const confirmFor = (session: Session) => async (req: { id: string; tool: string; args: unknown }): Promise<boolean> => {
    if (session.allowAlways.has(req.tool)) return true
    if (session.denyAlways.has(req.tool)) return false
    const res = await channel.request<{ outcome?: { outcome?: string; optionId?: string } }>(
      'session/request_permission',
      {
        sessionId: session.id,
        toolCall: {
          toolCallId: req.id,
          title: `${req.tool}`,
          kind: kindOf(req.tool),
          status: 'pending',
          rawInput: req.args,
        },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: `Always allow ${req.tool}`, kind: 'allow_always' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          { optionId: 'reject-always', name: `Always reject ${req.tool}`, kind: 'reject_always' },
        ],
      },
    )
    const outcome = res?.outcome
    if (outcome?.outcome !== 'selected') return false
    if (outcome.optionId === 'allow-always') session.allowAlways.add(req.tool)
    if (outcome.optionId === 'reject-always') session.denyAlways.add(req.tool)
    return outcome.optionId === 'allow-once' || outcome.optionId === 'allow-always'
  }

  /**
   * The editor's view of the project, as a `FileSystem` provider: reads see unsaved
   * buffers, writes land in the editor. `list` has no ACP equivalent, so it stays on
   * local disk — which is exactly why the seam takes a provider object, not a flag.
   */
  const fsFor = (session: Session): FileSystem => {
    const local = localFs(session.cwd)
    if (!clientFs?.readTextFile) return local
    return {
      ...local,
      read: async (handle) => {
        const res = await channel.request<{ content?: string }>('fs/read_text_file', { sessionId: session.id, path: handle })
        return res?.content ?? local.read(handle)
      },
      write: async (handle, content) => {
        if (!clientFs?.writeTextFile) return local.write(handle, content)
        await channel.request('fs/write_text_file', { sessionId: session.id, path: handle, content })
      },
      list: (handle: string): Promise<DirEntry[]> => local.list(handle),
    }
  }

  const handleRequest = (method: string, params: Record<string, unknown>, id: number | string): void => {
    void (async () => {
      switch (method) {
        case 'initialize': {
          const caps = params.clientCapabilities as { fs?: { readTextFile?: boolean; writeTextFile?: boolean } } | undefined
          clientFs = caps?.fs
          log(`acp: initialize from ${JSON.stringify(params.clientInfo ?? {})} fs=${JSON.stringify(clientFs ?? {})}`)
          channel.respond(id, {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: true } },
            agentInfo: { name: 'micro-harness', version: opts.version ?? '0.1.0' },
          })
          return
        }
        case 'session/new': {
          const cwd = String(params.cwd ?? opts.cwd)
          const sessionId = randomUUID()
          const hub = new EventHub()
          const session = { id: sessionId, cwd, hub } as Session
          const harness = new Harness({
            provider: opts.provider,
            model: opts.model,
            cwd,
            allowBash: opts.allowBash,
            sandbox: opts.sandbox,
            network: opts.network,
            maxSteps: opts.maxSteps,
            pricing: opts.pricing,
            tools: opts.tools,
            systemPrompt: opts.systemPrompt,
            hub,
            approval: opts.approval ?? 'full-auto',
            confirm: confirmFor(session),
            fs: fsFor(session),
          })
          session.harness = harness
          session.controller = null
          session.allowAlways = new Set()
          session.denyAlways = new Set()
          session.turn = 0
          session.cancelled = false
          harness.hub.on((tagged) => {
            const update = sessionUpdate(tagged.event, `${sessionId}-${session.turn}`)
            if (update) send(session, update)
          })
          sessions.set(sessionId, session)
          log(`acp: session ${sessionId.slice(0, 8)} in ${cwd}`)
          channel.respond(id, { sessionId })
          return
        }
        case 'session/prompt': {
          const session = sessions.get(String(params.sessionId))
          if (!session) {
            channel.fail(id, -32602, `unknown session: ${String(params.sessionId)}`)
            return
          }
          const text = promptText(params.prompt)
          session.turn += 1
          session.cancelled = false
          session.controller = new AbortController()
          try {
            await session.harness.send(text, session.controller.signal)
            // A cancel that arrived while the turn was running must be reported as
            // such even when nothing threw (ACP spec, "Prompt Turn · Cancellation").
            channel.respond(id, { stopReason: session.cancelled ? 'cancelled' : 'end_turn' })
          } catch (err) {
            if (session.cancelled || session.controller.signal.aborted) {
              channel.respond(id, { stopReason: 'cancelled' })
            } else {
              send(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `⚠️ ${String((err as Error).message)}` } })
              channel.respond(id, { stopReason: 'end_turn' })
            }
          } finally {
            session.controller = null
          }
          return
        }
        default:
          channel.fail(id, -32601, `method not found: ${method}`)
      }
    })()
  }

  const handleNotify = (method: string, params: Record<string, unknown>): void => {
    if (method === 'session/cancel') {
      const session = sessions.get(String(params.sessionId))
      if (session) {
        session.cancelled = true
        session.controller?.abort()
      }
    }
  }

  const channel = makeChannel(input, output, handleRequest, handleNotify, log)

  await new Promise<void>((resolve) => {
    input.on('end', () => resolve())
    input.on('close', () => resolve())
  })
  for (const s of sessions.values()) s.controller?.abort()
}
