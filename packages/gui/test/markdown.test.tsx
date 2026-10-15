import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from '../src/components/Markdown.tsx'

test('Markdown renders a fenced code block with a copy affordance and language label', () => {
  const html = renderToStaticMarkup(<Markdown text={'```ts\nconst x = 1\n```'} />)
  expect(html).toContain('copy')
  expect(html).toContain('ts')
  expect(html).toContain('<pre')
})

test('Markdown renders headings, lists and tables', () => {
  const html = renderToStaticMarkup(<Markdown text={'## Title\n\n- a\n- b\n\n| k | v |\n| - | - |\n| 1 | 2 |'} />)
  expect(html).toContain('<h2')
  expect(html).toContain('<li')
  expect(html).toContain('<table')
})
