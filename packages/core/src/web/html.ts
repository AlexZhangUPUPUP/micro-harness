/**
 * HTML → text, no dependencies. Deliberately crude: enough to hand a model
 * readable text and to pull result links out of a search page, not a parser.
 */

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  laquo: '«',
  raquo: '»',
  deg: '°',
  times: '×',
  divide: '÷',
  minus: '−',
  plusmn: '±',
  euro: '€',
  pound: '£',
  yen: '¥',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

/** Drop script/style/comments and turn block boundaries into newlines. */
export function htmlToText(html: string): string {
  let out = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dd|dt)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ')
  out = decodeEntities(out)
  return out
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function titleOf(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  return m ? decodeEntities(m[1]!).replace(/\s+/g, ' ').trim() : undefined
}

/** Text of the first tag whose attributes match `attr` (e.g. class="b_algo"). */
export function firstTagText(html: string, tag: string, attr?: { name: string; value: RegExp }): string | undefined {
  const open = new RegExp(`<${tag}\\b([^>]*)>`, 'gi')
  let m: RegExpExecArray | null
  while ((m = open.exec(html))) {
    if (attr) {
      const a = new RegExp(`${attr.name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i').exec(m[1] ?? '')
      const value = a ? a[1]!.replace(/^["']|["']$/g, '') : ''
      if (!attr.value.test(value)) continue
    }
    const rest = html.slice(m.index + m[0].length)
    const close = new RegExp(`</${tag}>`, 'i').exec(rest)
    return close ? rest.slice(0, close.index) : rest
  }
  return undefined
}
