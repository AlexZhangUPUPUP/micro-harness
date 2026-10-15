import { createElement, type ReactNode } from 'react'
import { highlightCode } from '../lib/highlight.ts'
import { cn } from '../lib/utils.ts'

/**
 * A small, safe Markdown renderer ported from public/app.js (md / blockMd /
 * inlineMd). Everything is emitted as React nodes; the only
 * `dangerouslySetInnerHTML` is the already-highlighted code HTML produced by
 * `highlightCode`, which escapes all input before wrapping it in spans.
 */

export interface MarkdownProps {
  text: string
  className?: string
}

/* ------------------------------------------------------------- inline */

const CODE_RE = /`([^`\n]+)`/y
const BOLD_RE = /\*\*([^*\n]+)\*\*/y
const EMD_RE = /\*([^*\n]+)\*/y
const LINK_RE = /\[([^\]\n]+)\]\((https?:[^)\s]+)\)/y

/** Unique key source for a single render pass (deterministic, so stable). */
type KeyGen = { n: number }

function parseInline(src: string, k: KeyGen): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  let buf = ''
  const flush = () => {
    if (buf) {
      out.push(buf)
      buf = ''
    }
  }

  while (i < src.length) {
    const ch = src[i]
    let done = false

    if (ch === '`') {
      CODE_RE.lastIndex = i
      const m = CODE_RE.exec(src)
      if (m) {
        flush()
        out.push(
          createElement(
            'code',
            { key: `c${k.n++}`, className: 'rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]' },
            m[1],
          ),
        )
        i = CODE_RE.lastIndex
        done = true
      }
    } else if (ch === '*') {
      BOLD_RE.lastIndex = i
      const b = BOLD_RE.exec(src)
      if (b) {
        flush()
        out.push(createElement('strong', { key: `b${k.n++}`, className: 'font-semibold' }, parseInline(b[1], k)))
        i = BOLD_RE.lastIndex
        done = true
      } else if (i === 0 || /[\s(]/.test(src[i - 1])) {
        EMD_RE.lastIndex = i
        const m = EMD_RE.exec(src)
        if (m) {
          flush()
          out.push(createElement('em', { key: `e${k.n++}`, className: 'italic' }, parseInline(m[1], k)))
          i = EMD_RE.lastIndex
          done = true
        }
      }
    } else if (ch === '[') {
      LINK_RE.lastIndex = i
      const m = LINK_RE.exec(src)
      if (m) {
        flush()
        out.push(
          createElement(
            'a',
            {
              key: `l${k.n++}`,
              href: m[2],
              target: '_blank',
              rel: 'noreferrer',
              className: 'text-teal underline decoration-teal/40 underline-offset-2 hover:decoration-teal',
            },
            parseInline(m[1], k),
          ),
        )
        i = LINK_RE.lastIndex
        done = true
      }
    }

    if (!done) {
      buf += ch
      i += 1
    }
  }
  flush()
  return out
}

/* -------------------------------------------------------------- blocks */

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
}

function paragraph(lines: string[], k: KeyGen): ReactNode {
  const children: ReactNode[] = []
  lines.forEach((line, idx) => {
    if (idx > 0) children.push(createElement('br', { key: `br${k.n++}` }))
    children.push(...parseInline(line, k))
  })
  return createElement('p', { key: `p${k.n++}`, className: 'my-1 whitespace-pre-wrap break-words' }, children)
}

function headingTag(lvl: number): 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
  return ('h' + lvl) as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
}

function headingCls(lvl: number): string {
  if (lvl === 1) return 'mb-1.5 mt-3 text-lg font-bold'
  if (lvl === 2) return 'mb-1.5 mt-3 text-base font-bold'
  if (lvl === 3) return 'mb-1 mt-2.5 text-[15px] font-semibold'
  return 'mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground'
}

function tableNode(header: string[], rows: string[][], k: KeyGen): ReactNode {
  const th = header.map((h) =>
    createElement(
      'th',
      { key: `th${k.n++}`, className: 'border-b border-border bg-muted/60 px-2.5 py-1.5 text-left font-semibold' },
      parseInline(h, k),
    ),
  )
  const trs = rows.map((r) =>
    createElement(
      'tr',
      { key: `tr${k.n++}` },
      r.map((c) =>
        createElement(
          'td',
          { key: `td${k.n++}`, className: 'border-b border-border px-2.5 py-1.5 align-top' },
          parseInline(c, k),
        ),
      ),
    ),
  )
  return createElement(
    'div',
    { key: `t${k.n++}`, className: 'my-2 overflow-x-auto rounded-lg border border-border' },
    createElement(
      'table',
      { className: 'w-full border-collapse text-sm' },
      createElement('thead', { key: `thd${k.n++}` }, createElement('tr', { key: `thr${k.n++}` }, th)),
      createElement('tbody', { key: `tb${k.n++}` }, trs),
    ),
  )
}

function parseBlocks(text: string, k: KeyGen): ReactNode[] {
  const lines = text.split('\n')
  const out: ReactNode[] = []
  const para: string[] = []
  const flush = () => {
    if (!para.length) return
    out.push(paragraph(para, k))
    para.length = 0
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // table: header row followed by a |---|---| separator
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flush()
      const header = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]))
        i += 1
      }
      out.push(tableNode(header, rows, k))
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      const lvl = h[1].length
      out.push(
        createElement(headingTag(lvl), { key: `h${k.n++}`, className: headingCls(lvl) }, parseInline(h[2], k)),
      )
      i += 1
      continue
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flush()
      out.push(createElement('hr', { key: `r${k.n++}`, className: 'my-3 border-border' }))
      i += 1
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      flush()
      const buf: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      out.push(
        createElement(
          'blockquote',
          { key: `q${k.n++}`, className: 'my-2 border-l-2 border-border pl-3 text-muted-foreground' },
          parseInline(buf.join('\n'), k),
        ),
      )
      continue
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flush()
      const ordered = /^\s*\d+\./.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''))
        i += 1
      }
      out.push(
        createElement(
          ordered ? 'ol' : 'ul',
          { key: `l${k.n++}`, className: ordered ? 'my-2 list-decimal pl-5' : 'my-2 list-disc pl-5' },
          items.map((t) => createElement('li', { key: `li${k.n++}`, className: 'my-0.5' }, parseInline(t, k))),
        ),
      )
      continue
    }

    if (!line.trim()) {
      flush()
      i += 1
      continue
    }

    para.push(line)
    i += 1
  }
  flush()
  return out
}

/* --------------------------------------------------------------- fences */

function prettyJson(text: string): string | null {
  const trimmed = text.trim()
  if (!/^[[{]/.test(trimmed)) return null
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed === null || typeof parsed !== 'object') return null
    return JSON.stringify(parsed, null, 2)
  } catch {
    return null
  }
}

function codeBlock(body: string, k: KeyGen): ReactNode {
  let lang = ''
  let code = body
  const nl = body.indexOf('\n')
  if (nl !== -1 && !body.slice(0, nl).includes(' ')) {
    lang = body.slice(0, nl).trim()
    code = body.slice(nl + 1)
  }
  code = code.replace(/\n$/, '')
  if (/^json$/i.test(lang)) code = prettyJson(code) ?? code

  const html = highlightCode(code, lang)
  return createElement(
    'div',
    { key: `code${k.n++}`, className: 'my-2 overflow-hidden rounded-lg border border-border bg-muted/40' },
    lang
      ? createElement(
          'div',
          {
            key: `cl${k.n++}`,
            className: 'border-b border-border bg-muted/60 px-3 py-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground',
          },
          lang,
        )
      : null,
    createElement(
      'pre',
      { key: `pre${k.n++}`, className: 'overflow-x-auto p-3 font-mono text-[13px] leading-relaxed' },
      createElement('code', { key: `c${k.n++}`, dangerouslySetInnerHTML: { __html: html } }),
    ),
  )
}

/* ---------------------------------------------------------- component */

/**
 * `.tok-*` colours for highlighted code. Kept here (not in index.css) so the
 * renderer is fully self-contained and theme-aware via the `.dark` class.
 */
const TOK_CSS = `
.pi-md .tok-k { color: #8250df; }
.pi-md .tok-s { color: #1a7f37; }
.pi-md .tok-c { color: #9aa1ab; font-style: italic; }
.pi-md .tok-n { color: #9a6700; }
.pi-md .tok-f { color: #0969da; }
.pi-md .tok-t { color: #1b7c83; }
.pi-md .tok-a { color: #9a6700; }
.pi-md .tok-v { color: #1b7c83; }
.pi-md .tok-p { color: #6b7280; }
.pi-md .tok-d { color: #d1242f; }
.dark .pi-md .tok-k { color: #a78bfa; }
.dark .pi-md .tok-s { color: #57c98a; }
.dark .pi-md .tok-c { color: #6b7280; font-style: italic; }
.dark .pi-md .tok-n { color: #d9a03a; }
.dark .pi-md .tok-f { color: #6aa8f0; }
.dark .pi-md .tok-t { color: #4fb8b0; }
.dark .pi-md .tok-a { color: #d9a03a; }
.dark .pi-md .tok-v { color: #4fb8b0; }
.dark .pi-md .tok-p { color: #9aa3af; }
.dark .pi-md .tok-d { color: #f0726f; }
`

export default function Markdown({ text, className }: MarkdownProps) {
  const src = text ?? ''
  const k: KeyGen = { n: 0 }
  const parts = src.split('```')
  const nodes: ReactNode[] = []

  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) nodes.push(codeBlock(parts[i], k))
    else nodes.push(...parseBlocks(parts[i], k))
  }

  return (
    <div className={cn('pi-md text-sm leading-relaxed', className)}>
      <style>{TOK_CSS}</style>
      {nodes}
    </div>
  )
}
