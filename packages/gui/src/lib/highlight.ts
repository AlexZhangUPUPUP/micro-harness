/**
 * Ported from public/app.js: zero-dependency syntax highlighting + ANSI SGR
 * to HTML. The highlighter emits `<span class="tok-x">` nodes; the consumer
 * (Markdown.tsx) owns the `.tok-*` colour palette so it can stay theme-aware.
 */

/* ------------------------------------------------------------------ esc */

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c])
}

/* ------------------------------------------------------ syntax highlight */

const HL_KEYWORDS = {
  js: 'const let var function return if else for while do break continue new class extends super this typeof instanceof in of delete void yield await async try catch finally throw switch case default import export from as static get set null undefined true false',
  py: 'def class return if elif else for while break continue import from as pass raise try except finally with lambda None True False and or not in is global nonlocal yield async await del assert',
  go: 'package import func var const type struct interface return if else for range break continue go defer chan map make new nil true false switch case default select',
  rust: 'fn let mut const struct enum impl trait for while loop if else match return use mod pub crate self super where async await move ref dyn box true false Some None Ok Err',
  java: 'public private protected class interface extends implements new return if else for while do switch case default break continue import package static final void int long double float boolean char String try catch finally throw throws this super null true false',
  sql: 'select from where insert update delete into values join left right inner outer on group by order having limit offset create table drop alter index as and or not null distinct count sum avg min max union',
}

type Rule = [string, RegExp]

function cLikeRules(keywords: string): Rule[] {
  const kw = new RegExp(`\\b(?:${keywords.split(/\s+/).filter(Boolean).join('|')})\\b`, 'y')
  return [
    ['c', /\/\/[^\n]*/y],
    ['c', /\/\*[\s\S]*?\*\//y],
    ['s', /`(?:[^`\\]|\\.)*`/y],
    ['s', /'(?:[^'\\\n]|\\.)*'/y],
    ['s', /"(?:[^"\\\n]|\\.)*"/y],
    ['n', /\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
    ['k', kw],
    ['f', /[A-Za-z_$][\w$]*(?=\s*\()/y],
    ['p', /[{}()\[\];,.:=+\-*/%<>!&|?~^@]+/y],
  ]
}

function rulesFor(lang?: string | null): Rule[] | null {
  const l = String(lang || '').toLowerCase()
  if (l === 'json' || l === 'jsonc') {
    return [
      ['k', /"(?:[^"\\]|\\.)*"(?=\s*:)/y],
      ['s', /"(?:[^"\\]|\\.)*"/y],
      ['n', /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y],
      ['c', /\b(?:true|false|null)\b/y],
      ['p', /[{}\[\],:]/y],
    ]
  }
  if (l === 'diff' || l === 'patch') {
    return [
      ['c', /^@@[^\n]*/my],
      ['f', /^\+\+\+[^\n]*/my],
      ['f', /^---[^\n]*/my],
      ['a', /^\+[^\n]*/my],
      ['d', /^-[^\n]*/my],
    ]
  }
  if (l === 'yaml' || l === 'yml' || l === 'toml' || l === 'ini') {
    return [
      ['c', /#[^\n]*/y],
      ['k', /^[ \t]*[\w.$-]+(?=\s*[:=])/my],
      ['s', /'(?:[^'\\\n]|\\.)*'/y],
      ['s', /"(?:[^"\\\n]|\\.)*"/y],
      ['n', /\b\d+(?:\.\d+)?\b/y],
      ['p', /[-:,\[\]{}]/y],
    ]
  }
  if (l === 'bash' || l === 'sh' || l === 'shell' || l === 'zsh' || l === 'console') {
    return [
      ['c', /#[^\n]*/y],
      ['s', /'(?:[^'\\\n]|\\.)*'/y],
      ['s', /"(?:[^"\\\n]|\\.)*"/y],
      ['v', /\$\{[^}\n]*\}|\$[A-Za-z_]\w*|\$[0-9?@#$!*-]/y],
      ['k', /\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|return|export|local|source|set|unset|exit|echo|printf|read)\b/y],
      ['n', /\b\d+\b/y],
      ['p', /[|&;(){}<>=]/y],
    ]
  }
  if (l === 'html' || l === 'xml' || l === 'svg' || l === 'vue') {
    return [
      ['c', /<!--[\s\S]*?-->/y],
      ['t', /<\/?[A-Za-z][\w:-]*/y],
      ['a', /[A-Za-z_:][\w:.-]*(?==)/y],
      ['s', /"(?:[^"\\]|\\.)*"/y],
      ['s', /'(?:[^'\\]|\\.)*'/y],
      ['p', /[<>/=]/y],
    ]
  }
  if (l === 'css' || l === 'scss' || l === 'less') {
    return [
      ['c', /\/\*[\s\S]*?\*\//y],
      ['k', /@[\w-]+/y],
      ['a', /[.#][\w-]+/y],
      ['f', /[\w-]+(?=\s*:)/y],
      ['s', /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/y],
      ['n', /-?\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms|deg|fr)?/y],
      ['p', /[{}();:,>+~*]/y],
    ]
  }
  if (l === 'py' || l === 'python') {
    return [
      ['c', /#[^\n]*/y],
      ['s', /"""[\s\S]*?"""/y],
      ['s', /'{3}[\s\S]*?'{3}/y],
      ['s', /f?"(?:[^"\\\n]|\\.)*"/y],
      ['s', /f?'(?:[^'\\\n]|\\.)*'/y],
      ['a', /@[\w.]+/y],
      ['n', /\b\d+(?:\.\d+)?\b/y],
      ['k', new RegExp(`\\b(?:${HL_KEYWORDS.py.split(/\s+/).join('|')})\\b`, 'y')],
      ['f', /[A-Za-z_]\w*(?=\s*\()/y],
      ['p', /[{}()\[\];,.:=+\-*/%<>!&|]+/y],
    ]
  }
  if (l === 'sql') {
    return [
      ['c', /--[^\n]*/y],
      ['s', /'(?:[^'\\\n]|\\.)*'/y],
      ['k', new RegExp(`\\b(?:${HL_KEYWORDS.sql.split(/\s+/).join('|')})\\b`, 'iy')],
      ['n', /\b\d+(?:\.\d+)?\b/y],
      ['p', /[();,.*=<>]/y],
    ]
  }
  if (/^(?:js|jsx|ts|tsx|mjs|cjs|javascript|typescript|json5)$/.test(l)) return cLikeRules(HL_KEYWORDS.js)
  if (/^(?:go|golang)$/.test(l)) return cLikeRules(HL_KEYWORDS.go)
  if (/^(?:rs|rust)$/.test(l)) return cLikeRules(HL_KEYWORDS.rust)
  if (/^(?:java|kt|kotlin)$/.test(l)) return cLikeRules(HL_KEYWORDS.java)
  if (/^(?:c|cpp|cc|h|hpp|cs|swift|php|scala)$/.test(l)) return cLikeRules(HL_KEYWORDS.java)
  return null
}

const HL_MAX = 200_000

/**
 * Highlight source code into safe HTML. Input is escaped before being wrapped
 * in spans, so the result is safe for `dangerouslySetInnerHTML`.
 */
export function highlightCode(code: string | null | undefined, lang?: string | null | undefined): string {
  const src = String(code ?? '')
  const rules = src.length > HL_MAX ? null : rulesFor(lang)
  if (!rules) return esc(src)
  let out = ''
  let plain = ''
  let i = 0
  const flush = () => {
    if (plain) {
      out += esc(plain)
      plain = ''
    }
  }
  while (i < src.length) {
    let hit: [string, string] | null = null
    for (const rule of rules) {
      rule[1].lastIndex = i
      const m = rule[1].exec(src)
      if (m && m[0]) {
        hit = [rule[0], m[0]]
        break
      }
    }
    if (hit) {
      flush()
      out += `<span class="tok-${hit[0]}">${esc(hit[1])}</span>`
      i += hit[1].length
    } else {
      plain += src[i]
      i += 1
    }
  }
  flush()
  return out
}

/* ------------------------------------------------------------------ ansi */

/** Colours mapped onto the new theme's HSL variables where they exist. */
const ANSI_FG: Record<number, string> = {
  30: 'hsl(var(--muted-foreground))',
  31: 'hsl(var(--destructive))',
  32: '#2ea043', // green — no theme token, kept legible on light + dark
  33: 'hsl(var(--gold))',
  34: '#58a6ff', // blue
  35: '#bc8cff', // purple
  36: 'hsl(var(--teal))',
  37: 'hsl(var(--foreground))',
  90: 'hsl(var(--muted-foreground))',
  91: 'hsl(var(--destructive))',
  92: '#2ea043',
  93: 'hsl(var(--gold))',
  94: '#58a6ff',
  95: '#bc8cff',
  96: 'hsl(var(--teal))',
  97: 'hsl(var(--foreground))',
}

const ANSI_RE = /\u001b\[([0-9;]*)m/g

/** Turn SGR escape codes into spans so `ls --color`, logs and test output stay readable. */
export function ansiToHtml(text: string): string {
  let html = ''
  let last = 0
  let bold = false
  let fg: string | null = null
  const emit = (chunk: string) => {
    if (!chunk) return
    const css: string[] = []
    if (bold) css.push('font-weight:700')
    if (fg) css.push(`color:${fg}`)
    html += css.length ? `<span style="${css.join(';')}">${esc(chunk)}</span>` : esc(chunk)
  }
  for (const m of String(text).matchAll(ANSI_RE)) {
    emit(text.slice(last, m.index))
    last = m.index + m[0].length
    const codes = (m[1] || '').split(';').filter(Boolean).map(Number)
    if (!codes.length || codes.includes(0)) {
      bold = false
      fg = null
    }
    for (const c of codes) {
      if (c === 1) bold = true
      else if (c === 22) bold = false
      else if (c === 39) fg = null
      else if (ANSI_FG[c]) fg = ANSI_FG[c]
    }
  }
  emit(text.slice(last))
  return html
}
