/**
 * Partial patch application.
 *
 * The changes panel lets you accept or reject individual hunks of an agent's diff.
 * Doing that correctly means applying *some* hunks of a unified diff to the current
 * content of the target file — so this module parses a diff and replays only the
 * accepted hunks, leaving the rest of the file (and the rejected hunks) as they are.
 *
 * Hunk indices are **global across the whole diff** (the order `@@` appears), so the
 * GUI and the server agree on numbering without any extra bookkeeping.
 */

export interface HunkInfo {
  /** Global index across the diff. */
  index: number
  /** The `@@ -a,b +c,d @@` line, including any trailing section heading. */
  header: string
  /** Target path this hunk belongs to (diff prefixes stripped). */
  file: string
  oldStart: number
  oldLen: number
  /** Old side: context + deleted lines, markers stripped. */
  oldLines: string[]
  /** New side: context + added lines, markers stripped. */
  newLines: string[]
}

export interface ParsedDiff {
  hunks: HunkInfo[]
  /** Paths the diff deletes outright. */
  deleted: Set<string>
  /** Paths whose text does not end with a newline. */
  noNewline: Set<string>
}

const stripPrefix = (p: string): string => p.trim().replace(/^\w\//, '')

/** Parse a unified diff into globally-numbered hunks. */
export function parseDiff(diff: string): ParsedDiff {
  const hunks: HunkInfo[] = []
  const deleted = new Set<string>()
  const noNewline = new Set<string>()
  let file = ''
  let current: HunkInfo | null = null
  let lastMarker = ''

  // The diff text itself ends with a newline; that phantom last element must not be
  // mistaken for an empty context line of the final hunk.
  const lines = diff.endsWith('\n') ? diff.slice(0, -1).split('\n') : diff.split('\n')

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const m = /^diff --git \S+ (\S+)$/.exec(line)
      if (m) file = stripPrefix(m[1]!)
      current = null
      continue
    }
    if (line.startsWith('deleted file mode')) {
      if (file) deleted.add(file)
      continue
    }
    if (line.startsWith('new file mode')) {
      deleted.delete(file)
      continue
    }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4)
      if (target !== '/dev/null') file = stripPrefix(target)
      current = null
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('index ') || line.startsWith('similarity') || line.startsWith('rename ')) {
      current = null
      continue
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      current = {
        index: hunks.length,
        header: line,
        file,
        oldStart: m ? Number(m[1]) : 0,
        oldLen: m ? (m[2] === undefined ? 1 : Number(m[2])) : 0,
        oldLines: [],
        newLines: [],
      }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('\\')) {
      // "\ No newline at end of file" refers to the line just emitted; it only says
      // something about our result when that line is on the new side.
      if (lastMarker === '+' || lastMarker === ' ') noNewline.add(current.file)
      continue
    }
    const marker = line[0]
    const body = line.slice(1)
    lastMarker = marker
    if (marker === ' ') {
      current.oldLines.push(body)
      current.newLines.push(body)
    } else if (marker === '-') {
      current.oldLines.push(body)
    } else if (marker === '+') {
      current.newLines.push(body)
    }
  }

  return { hunks, deleted, noNewline }
}

export interface HunkApplyResult {
  content: string
  /** Hunk indices that were applied. */
  applied: number[]
  /** Accepted hunks that could not be applied because the target drifted. */
  conflicted: number[]
  deleted: boolean
}

/**
 * Apply only `accepted` (global hunk indices) of the diff's hunks for `target`
 * onto `base`, returning the resulting file content.
 *
 * A hunk whose old side no longer matches the target is reported in `conflicted`
 * and left untouched — never silently mis-applied.
 */
export function applyHunkSelection(
  base: string,
  diff: string,
  target: string,
  accepted: number[],
): HunkApplyResult {
  const parsed = parseDiff(diff)
  const mine = parsed.hunks.filter((h) => h.file === target)
  const empty: HunkApplyResult = { content: base, applied: [], conflicted: [], deleted: false }
  if (mine.length === 0) return empty

  const wanted = new Set(accepted)
  const lines = base === '' ? [] : base.split('\n')
  // A trailing newline shows up as a final empty element; drop it while working and
  // re-add it at the end so the file round-trips byte for byte.
  const hadTrailing = lines.length > 0 && lines[lines.length - 1] === ''
  const body = hadTrailing ? lines.slice(0, -1) : lines
  const out: string[] = []
  const applied: number[] = []
  const conflicted: number[] = []
  let cursor = 0

  for (const hunk of mine) {
    const at = Math.max(0, hunk.oldStart - 1)
    if (at < cursor) continue // overlapping hunks: skip rather than corrupt
    out.push(...body.slice(cursor, at))
    const slice = body.slice(at, at + hunk.oldLen)
    const matches = slice.length === hunk.oldLines.length && slice.every((l, i) => l === hunk.oldLines[i])
    if (wanted.has(hunk.index)) {
      if (matches) {
        out.push(...hunk.newLines)
        applied.push(hunk.index)
      } else {
        // The target moved on: keep what is there and report the conflict.
        out.push(...slice)
        conflicted.push(hunk.index)
      }
    } else {
      out.push(...slice)
    }
    cursor = at + hunk.oldLen
  }
  out.push(...body.slice(cursor))

  const trailing = !parsed.noNewline.has(target)
  const content = out.length === 0 ? '' : trailing ? out.join('\n') + '\n' : out.join('\n')
  return { content, applied, conflicted, deleted: parsed.deleted.has(target) && out.length === 0 }
}
