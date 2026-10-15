/**
 * In-memory approval broker — the other half of the GUI approval loop.
 *
 * The harness asks for a decision via `ask()`, the HTTP route answers it via
 * `answer()`, and the `permission.request`/`permission.result` events are what
 * the client sees on the SSE stream. A request that is never answered times out
 * and is denied (the default approval policy is always "deny on uncertainty").
 */

export interface ApprovalBroker {
  /** Called by the harness. Resolves when the client answers, or denies on timeout. */
  ask(req: { id: string; tool: string; args: unknown; agentId: string }): Promise<boolean>
  /** Called by the HTTP route. Returns false when the id is unknown/已 resolved. */
  answer(requestId: string, allow: boolean): boolean
  /** Ids currently waiting (for tests / diagnostics). */
  pending(): string[]
  /** Deny everything still waiting (session deleted, server stopping). */
  cancelAll(): void
}

interface Waiting {
  resolve: (allow: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export function createApprovalBroker(opts?: { timeoutMs?: number }): ApprovalBroker {
  const timeoutMs = opts?.timeoutMs ?? 120_000
  const waiting = new Map<string, Waiting>()

  const settle = (requestId: string, allow: boolean): boolean => {
    const entry = waiting.get(requestId)
    if (!entry) return false
    waiting.delete(requestId)
    clearTimeout(entry.timer)
    entry.resolve(allow)
    return true
  }

  return {
    ask(req) {
      return new Promise<boolean>((resolve) => {
        const entry: Waiting = { resolve, timer: undefined as unknown as ReturnType<typeof setTimeout> }
        entry.timer = setTimeout(() => {
          // Only remove ourselves: a duplicate `ask` for the same id must not
          // clear the newer entry, and the fired timer needs no clearing.
          if (waiting.get(req.id) === entry) waiting.delete(req.id)
          resolve(false)
        }, timeoutMs)
        waiting.set(req.id, entry)
      })
    },

    answer(requestId, allow) {
      return settle(requestId, allow)
    },

    pending() {
      return [...waiting.keys()]
    },

    cancelAll() {
      for (const [id, entry] of [...waiting]) {
        waiting.delete(id)
        clearTimeout(entry.timer)
        entry.resolve(false)
      }
    },
  }
}
