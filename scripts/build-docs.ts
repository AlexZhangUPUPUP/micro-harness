#!/usr/bin/env bun
/**
 * Build the static documentation site into `site/`.
 *
 * The site is a flat set of HTML pages rendered from the repo's Markdown, with
 * one shared sidebar. It is deliberately dependency-light: `marked` is the only
 * devDependency, and the output is plain HTML + CSS that any static host can
 * serve (the Pages workflow uploads `site/` as-is).
 *
 *   bun run docs:build      # writes site/
 *
 * Cross-document links are rewritten to the generated pages, images under
 * docs/ are copied to site/assets/, and any other repo path is pointed at the
 * GitHub blob so the site never has dead relative links.
 */
import { marked } from 'marked'
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const OUT = join(ROOT, 'site')
const REPO = 'https://github.com/AlexZhangUPUPUP/micro-harness'

interface Page {
  file: string
  slug: string
  title: string
  group: string
}

const PAGES: Page[] = [
  { file: 'README.md', slug: 'index', title: 'Overview', group: 'Start' },
  { file: 'README.zh-CN.md', slug: 'index.zh', title: '概览', group: '中文' },
  { file: 'ARCHITECTURE.md', slug: 'architecture', title: 'Architecture', group: 'Design' },
  { file: 'docs/design-comparison.md', slug: 'design-comparison', title: 'Design notes', group: 'Design' },
  { file: 'scripts/evals/README.md', slug: 'evals', title: 'Evals', group: 'Design' },
  { file: 'docs/design-comparison.zh-CN.md', slug: 'design-comparison.zh', title: '设计笔记', group: '中文' },
  { file: 'ROADMAP.md', slug: 'roadmap', title: 'Roadmap', group: 'Project' },
  { file: 'PROGRESS.md', slug: 'progress', title: 'Progress log', group: 'Project' },
]

const SLUGS = new Map(PAGES.map((p) => [p.file, `${p.slug}.html`]))

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Rewrite links so the flat site stays navigable. */
function rewrite(html: string): string {
  let out = html

  // Cross-document links: docs/design-comparison.md -> design-comparison.html
  for (const [file, target] of SLUGS) {
    out = out.split(`href="${file}"`).join(`href="${target}"`)
    out = out.split(`href="./${file}"`).join(`href="${target}"`)
  }

  // Screenshots and other images.
  out = out.replace(/(href|src)="(?:\.\/)?docs\/([^"/]+\.(?:png|jpe?g|svg|gif|webp))"/g, '$1="assets/$2"')

  // Anything else that is a local repo path (install.sh, packages/...) -> GitHub.
  out = out.replace(/href="([^"]+)"/g, (match, href: string) => {
    if (/^(https?:|#|mailto:)/.test(href) || href.endsWith('.html') || href.startsWith('assets/')) {
      return match
    }
    return `href="${REPO}/blob/main/${href.replace(/^\.\//, '')}"`
  })

  // External links open away from the docs.
  out = out.replace(/href="(https?:\/\/[^"]+)"/g, 'href="$1" target="_blank" rel="noreferrer"')

  return out
}

const STYLE = `
:root {
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #656d76;
  --border: #d0d7de;
  --accent: #0969da;
  --code-bg: #f6f8fa;
  --sidebar-bg: #f6f8fa;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #8d96a0;
    --border: #30363d;
    --accent: #4493f8;
    --code-bg: #161b22;
    --sidebar-bg: #010409;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  width: 260px;
  padding: 24px 18px;
  overflow-y: auto;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
}
.brand { display: block; font-weight: 700; font-size: 17px; color: var(--fg); letter-spacing: -0.01em; }
.tagline { margin: 4px 0 22px; font-size: 12.5px; color: var(--muted); }
.group { margin-bottom: 20px; }
.group-title {
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.item { display: block; padding: 4px 8px; margin: 1px -8px; border-radius: 6px; color: var(--fg); font-size: 14px; }
.item:hover { background: var(--code-bg); text-decoration: none; }
.item.active { background: var(--code-bg); color: var(--accent); font-weight: 600; }
.foot { margin-top: 28px; padding-top: 14px; border-top: 1px solid var(--border); font-size: 12.5px; color: var(--muted); }
main { margin-left: 260px; padding: 40px 48px 96px; max-width: 1080px; }
.content { max-width: 780px; }
h1, h2, h3, h4 { line-height: 1.25; letter-spacing: -0.01em; }
h1 { font-size: 2rem; margin: 0 0 18px; }
h2 { font-size: 1.4rem; margin: 34px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
h3 { font-size: 1.12rem; margin: 24px 0 8px; }
p, ul, ol, table, pre, blockquote { margin: 0 0 16px; }
code {
  font: 0.88em ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  background: var(--code-bg);
  padding: 0.15em 0.35em;
  border-radius: 4px;
}
pre {
  padding: 14px 16px;
  overflow-x: auto;
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}
pre code { padding: 0; background: transparent; font-size: 13px; line-height: 1.55; }
blockquote {
  padding: 0 14px;
  color: var(--muted);
  border-left: 3px solid var(--border);
}
table { border-collapse: collapse; width: 100%; font-size: 14.5px; }
th, td { padding: 7px 12px; border: 1px solid var(--border); text-align: left; vertical-align: top; }
th { background: var(--code-bg); }
img { max-width: 100%; height: auto; }
hr { height: 1px; margin: 28px 0; border: 0; background: var(--border); }
details { margin: 0 0 16px; }
summary { cursor: pointer; }
@media (max-width: 860px) {
  .sidebar { position: static; width: auto; border-right: 0; border-bottom: 1px solid var(--border); }
  main { margin-left: 0; padding: 28px 20px 64px; }
}
`

function layout(page: Page, body: string): string {
  const groups = [...new Set(PAGES.map((p) => p.group))]
  const nav = groups
    .map(
      (group) =>
        `<div class="group"><div class="group-title">${esc(group)}</div>` +
        PAGES.filter((p) => p.group === group)
          .map(
            (p) =>
              `<a class="item${p.slug === page.slug ? ' active' : ''}" href="${p.slug}.html">${esc(p.title)}</a>`,
          )
          .join('') +
        '</div>',
    )
    .join('')

  return `<!doctype html>
<html lang="${page.slug.endsWith('.zh') ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} · micro-harness</title>
<meta name="description" content="A coding-agent harness you can read end to end.">
<link rel="stylesheet" href="style.css">
</head>
<body>
<aside class="sidebar">
<a class="brand" href="index.html">micro-harness</a>
<p class="tagline">A coding-agent harness you can read end to end.</p>
<nav>${nav}</nav>
<p class="foot"><a href="${REPO}" target="_blank" rel="noreferrer">GitHub ↗</a><br>Built from <code>main</code></p>
</aside>
<main><div class="content">
${body}
</div></main>
</body>
</html>
`
}

async function main(): Promise<void> {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(join(OUT, 'assets'), { recursive: true })

  for (const page of PAGES) {
    const src = await Bun.file(join(ROOT, page.file)).text()
    const html = marked.parse(src, { async: false, gfm: true }) as string
    await writeFile(join(OUT, `${page.slug}.html`), layout(page, rewrite(html)))
    console.log(`  ${page.file} -> site/${page.slug}.html`)
  }

  const assets = join(ROOT, 'docs')
  for (const file of await readdir(assets)) {
    if (/\.(png|jpe?g|svg|gif|webp)$/i.test(file)) {
      await copyFile(join(assets, file), join(OUT, 'assets', file))
    }
  }

  await writeFile(join(OUT, 'style.css'), STYLE)
  await writeFile(join(OUT, '.nojekyll'), '')
  console.log(`\nsite/ written: ${PAGES.length} pages`)
}

await main()
