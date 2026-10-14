import { test, expect } from 'bun:test'
import { createContext, type Context } from '../src/index.ts'

test('a plugin waits for its dependency, then activates', () => {
  const ctx = createContext()
  const log: string[] = []

  ctx.plugin({ name: 'a', inject: ['b'], apply() { log.push('a') } })
  expect(ctx.plugins().find((p) => p.name === 'a')?.status).toBe('waiting')

  ctx.plugin({ name: 'b', apply(c) { log.push('b'); c.provide('b', 1) } })

  expect(log).toEqual(['b', 'a'])
  expect(ctx.plugins().find((p) => p.name === 'a')?.status).toBe('active')
})

test('losing a dependency deactivates dependents and disposes their effects', () => {
  const ctx = createContext()
  const log: string[] = []

  const b = ctx.plugin({ name: 'b', apply(c) { c.provide('b', 1) } })
  ctx.plugin({
    name: 'a',
    inject: ['b'],
    apply(c) {
      log.push('a:up')
      c.effect(() => () => { log.push('a:down') })
    },
  })
  expect(log).toEqual(['a:up'])

  b.dispose()

  expect(log).toEqual(['a:up', 'a:down'])
  expect(ctx.has('b')).toBe(false)
  expect(ctx.plugins().find((p) => p.name === 'a')?.status).toBe('waiting')
})

test('provide refuses duplicates', () => {
  const ctx = createContext()
  ctx.provide('x', 1)
  expect(() => ctx.provide('x', 2)).toThrow()
})

test('dispose runs effects in reverse order and awaits async disposals', async () => {
  const ctx = createContext()
  const order: string[] = []
  ctx.effect(() => {
    order.push('e1')
    return () => { order.push('e1:dispose') }
  })
  ctx.effect(() => {
    order.push('e2')
    return async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push('e2:dispose')
    }
  })
  await ctx.dispose()
  expect(order).toEqual(['e1', 'e2', 'e2:dispose', 'e1:dispose'])
})

test('a failing plugin is isolated and reported', () => {
  const ctx = createContext()
  ctx.plugin({ name: 'boom', apply() { throw new Error('nope') } })
  ctx.plugin({ name: 'ok', apply(c) { c.provide('ok', true) } })

  const boom = ctx.plugins().find((p) => p.name === 'boom')
  expect(boom?.status).toBe('failed')
  expect(boom?.error).toContain('nope')
  expect(ctx.has('ok')).toBe(true)
})

test('invalid config fails the plugin without throwing', () => {
  const ctx = createContext()
  const Config = {
    parse(v: unknown) {
      const model = (v as { model?: unknown })?.model
      if (typeof model !== 'string') throw new Error('model required')
      return { model }
    },
  }
  ctx.plugin({ name: 'p', Config, apply() {} }, {})
  const p = ctx.plugins()[0]
  expect(p?.status).toBe('failed')
  expect(p?.error).toContain('model required')
})

test('fork inherits services but isolate does not leak upward', () => {
  const ctx = createContext()
  ctx.provide('shared', 'root')

  const child = ctx.fork()
  expect(child.get('shared')).toBe('root')

  child.isolate('shared', 'child')
  expect(child.get('shared')).toBe('child')
  expect(ctx.get('shared')).toBe('root')
})

test('isolate in one fork does not leak to a sibling', () => {
  const ctx = createContext()
  ctx.provide('n', 1)
  const a = ctx.fork({ scope: 'a' })
  const b = ctx.fork({ scope: 'b' })
  a.isolate('n', 2)
  expect(a.get('n')).toBe(2)
  expect(b.get('n')).toBe(1)
})

test('events fan out; a scope disposal removes its listeners', async () => {
  const ctx = createContext()
  const seen: unknown[] = []
  ctx.on('ping', (p) => seen.push(p))

  const child = ctx.fork()
  let childSeen = 0
  child.on('ping', () => childSeen++)

  ctx.emit('ping', 1)
  expect(seen).toEqual([1])
  expect(childSeen).toBe(1)

  await child.dispose()
  ctx.emit('ping', 2)
  expect(childSeen).toBe(1)
})

test('inject() reacts to services appearing and disappearing', () => {
  const ctx = createContext()
  const log: string[] = []
  ctx.inject(['svc'], () => {
    log.push('up')
    return () => log.push('down')
  })
  expect(log).toEqual([])

  const provider = ctx.plugin({ name: 'provider', apply(c) { c.provide('svc', 42) } })
  expect(log).toEqual(['up'])
  expect(ctx.get('svc')).toBe(42)

  provider.dispose()
  expect(log).toEqual(['up', 'down'])
})
