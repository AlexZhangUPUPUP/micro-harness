import { test, expect } from 'bun:test'
import { decodeEntities, htmlToText, titleOf, firstTagText } from '../src/web/html.ts'

test('decodeEntities handles named, decimal and hex', () => {
  expect(decodeEntities('a &amp; b')).toBe('a & b')
  expect(decodeEntities('&#65;&#x41;')).toBe('AA')
  expect(decodeEntities('x&nbsp;y')).toBe('x y')
  expect(decodeEntities('&notaentity;')).toBe('&notaentity;')
})

test('htmlToText drops scripts/styles/comments and keeps structure', () => {
  const html = `<html><head><title>T</title><style>p{color:red}</style>
    <script>alert(1)</script></head><body><h1>Hi</h1><p>one &amp; two</p>
    <!-- c --><ul><li>a</li><li>b</li></ul></body></html>`
  const text = htmlToText(html)
  expect(text).toContain('Hi')
  expect(text).toContain('one & two')
  expect(text).toContain('• a')
  expect(text).toContain('• b')
  expect(text).not.toContain('alert')
  expect(text).not.toContain('color:red')
  expect(text).not.toContain('<')
})

test('titleOf / firstTagText', () => {
  expect(titleOf('<title> deepseek  harness </title>')).toBe('deepseek harness')
  expect(firstTagText('<div class="x">a</div><div class="b_algo">keep me</div>', 'div', { name: 'class', value: /b_algo/ })).toBe(
    'keep me',
  )
})
