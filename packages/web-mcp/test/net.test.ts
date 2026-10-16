import { test, expect } from 'bun:test'
import { isPublicAddress, isFetchableHost, resolvePublic, WebError } from '../src/net.ts'

test('isPublicAddress rejects the SSRF-relevant ranges', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.5.4',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
  ]) {
    expect(isPublicAddress(ip)).toBe(false)
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '2001:4860:4860::8888']) {
    expect(isPublicAddress(ip)).toBe(true)
  }
})

test('isFetchableHost only accepts dotted DNS names', () => {
  expect(isFetchableHost('example.com')).toBe(true)
  expect(isFetchableHost('localhost')).toBe(false)
  expect(isFetchableHost('intranet')).toBe(false)
  expect(isFetchableHost('printer.local')).toBe(false)
  expect(isFetchableHost('foo.localhost')).toBe(false)
})

test('resolvePublic refuses private literals without touching DNS', async () => {
  await expect(resolvePublic('127.0.0.1')).rejects.toThrow(WebError)
  await expect(resolvePublic('169.254.169.254')).rejects.toThrow(/non-public/)
  await expect(resolvePublic('intranet')).rejects.toThrow(/public host/)
})

test('resolvePublic accepts a public literal', async () => {
  const r = await resolvePublic('93.184.216.34')
  expect(r.address).toBe('93.184.216.34')
  expect(r.family).toBe(4)
})
