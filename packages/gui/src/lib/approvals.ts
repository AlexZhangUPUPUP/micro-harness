/**
 * Approval derivation + the answer call. Pure derivation is kept out of the
 * React components so it can be unit-tested without a DOM, matching the rest of
 * `lib/derive.ts`. The wire is:
 *
 *   POST /api/sessions/:sessionId/permissions/:requestId  body: { allow: boolean }
 */

import { api, type TaggedEvent } from './api.ts'

export interface PendingApproval {
  id: string
  tool: string
  args?: unknown
  agentId: string
  t: number
}

/** `permission.request` events with no matching `permission.result` yet. */
export function pendingApprovals(events: TaggedEvent[]): PendingApproval[] {
  const resolved = new Set<string>()
  for (const e of events) {
    const ev = e.event
    if (ev.type === 'permission.result' && ev.id !== undefined) resolved.add(String(ev.id))
  }

  const out: PendingApproval[] = []
  for (const e of events) {
    const ev = e.event
    if (ev.type !== 'permission.request') continue
    if (ev.id !== undefined && resolved.has(String(ev.id))) continue
    out.push({
      id: String(ev.id ?? ''),
      tool: String(ev.tool ?? ''),
      args: ev.args,
      agentId: e.agentId,
      t: e.t,
    })
  }
  return out
}

/** Whether a `permission.result` for `id` has been seen in the stream. */
export function isResolved(events: TaggedEvent[], id: string): boolean {
  return events.some((e) => e.event.type === 'permission.result' && e.event.id !== undefined && String(e.event.id) === id)
}

/** Answer a pending permission request (allow/deny) on the server. */
export function decidePermission(sessionId: string, requestId: string, allow: boolean): Promise<{ ok: boolean }> {
  return api.decidePermission(sessionId, requestId, allow)
}
