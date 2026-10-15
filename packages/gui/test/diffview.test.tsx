import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DiffView } from '../src/components/DiffView.tsx'

test('DiffView colors added, removed, hunk and file-header lines', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    'index 111..222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,2 +1,2 @@',
    '-old line',
    '+new line',
    ' unchanged',
  ].join('\n')
  const html = renderToStaticMarkup(<DiffView text={diff} />)
  expect(html).toContain('bg-teal/10') // added
  expect(html).toContain('bg-destructive/10') // removed
  expect(html).toContain('text-gold/90') // @@ hunk header
  expect(html).toContain('text-muted-foreground/70') // --- / +++ meta
})

test('DiffView caps at 2000 lines', () => {
  const html = renderToStaticMarkup(<DiffView text={Array.from({ length: 2500 }, (_, i) => `+line ${i}`).join('\n')} />)
  expect(html.split('line ').length - 1).toBe(2000)
})
