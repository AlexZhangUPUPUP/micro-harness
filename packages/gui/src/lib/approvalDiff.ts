/**
 * Turn an approval's tool arguments into a readable diff.
 *
 * `edit_file` gives us the old/new strings directly; `write_file` needs the
 * current content, which the harness includes in `permission.request.preview`.
 * Everything else falls back to the raw arguments.
 */

export type DiffKind = 'add' | 'del' | 'ctx'

export interface DiffLine {
  kind: DiffKind
  text: string
}

/** A cap so a huge write cannot freeze the renderer. */
const MAX_LINES = 400

/** Line diff via LCS; oversized inputs degrade to "all removed, all added". */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  if (a.length + b.length > MAX_LINES * 2) {
    return [
      ...a.slice(0, MAX_LINES).map((text) => ({ kind: 'del' as const, text })),
      ...b.slice(0, MAX_LINES).map((text) => ({ kind: 'add' as const, text })),
    ]
  }

  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i]! })
      i += 1
      j += 1
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      out.push({ kind: 'del', text: a[i]! })
      i += 1
    } else {
      out.push({ kind: 'add', text: b[j]! })
      j += 1
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++]! })
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! })
  return out
}

interface WriteArgs {
  old_string?: string
  new_string?: string
  content?: string
  edits?: Array<{ old_string?: string; new_string?: string }>
}

/** Diff for `edit_file` / `write_file`; null when the tool has no diffable args. */
export function approvalDiff(tool: string, args: unknown, before?: string): DiffLine[] | null {
  const a = (args ?? {}) as WriteArgs
  if (tool === 'edit_file') {
    const edits = Array.isArray(a.edits) ? a.edits : [{ old_string: a.old_string, new_string: a.new_string }]
    const lines: DiffLine[] = []
    for (const edit of edits) {
      const oldText = String(edit.old_string ?? '')
      if (!oldText) continue
      lines.push(...lineDiff(oldText, String(edit.new_string ?? '')))
    }
    return lines.length ? lines : null
  }
  if (tool === 'write_file') {
    const content = String(a.content ?? '')
    // A missing `before` means a new file: do not show a phantom deleted line.
    if (before === undefined) {
      return content ? content.split('\n').map((text) => ({ kind: 'add' as const, text })) : []
    }
    return lineDiff(before, content)
  }
  return null
}
