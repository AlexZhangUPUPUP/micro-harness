/**
 * The plugin kernel — ARCHITECTURE.md §3.
 *
 * Four things, and only four:
 *   - a service registry with dependency injection (`provide` / `inject`)
 *   - plugin lifecycle: waiting → active → failed, with clean disposal
 *   - scoped contexts: `fork()` (new scope) and `isolate()` (shadow a service)
 *   - an event bus
 *
 * Deliberately small. No HTTP, no CLI, no storage, no framework.
 */

export interface Disposable {
  dispose(): void | Promise<void>
}

/** What an effect/injection/plugin may return to register cleanup. */
export type Cleanup = void | Disposable | (() => void)

/** Structural validator — anything with `parse` works (zod, valibot, hand-written). */
export interface Schema<T> {
  parse(input: unknown): T
}

export type PluginStatus = 'waiting' | 'active' | 'failed' | 'disposed'

export interface Plugin<C = unknown> {
  name: string
  inject?: string[]
  Config?: Schema<C>
  apply(ctx: Context, config: C): Cleanup
}

export interface PluginRecord {
  name: string
  status: PluginStatus
  error?: string
}

export interface Context {
  /** Human-readable scope name (diagnostics, event tagging). */
  readonly scope: string
  readonly disposed: boolean

  /** Register a new service. Throws if the name is already available here. */
  provide<T>(name: string, value: T): void
  /** Shadow a service in this scope (allowed to override an ancestor's). */
  isolate<T>(name: string, value: T): void
  get<T>(name: string): T
  has(name: string): boolean

  /** Run `fn`, disposing whatever it returns when the owning plugin/scope goes away. */
  effect(fn: () => Cleanup): void
  on(event: string, fn: (payload: unknown) => void): void
  emit(event: string, payload?: unknown): void

  /** Run `fn` as soon as every dependency is available; re-run when they change. */
  inject(deps: string[], fn: (ctx: Context) => Cleanup): Disposable

  /** Mount a plugin. Its `apply` runs in THIS scope once its deps are ready. */
  plugin<C>(plugin: Plugin<C>, config?: unknown): Disposable

  /** A child scope: shares the event bus, inherits services, isolates new state. */
  fork(overrides?: Record<string, unknown>): Context

  plugins(): PluginRecord[]
  dispose(): Promise<void>
}

interface Injection {
  deps: string[]
  fn: (ctx: Context) => Cleanup
  disposable: Disposable | null
  owner: Entry | null
}

interface Entry {
  plugin: Plugin
  config: unknown
  status: PluginStatus
  error?: string
  disposables: Disposable[]
  provided: Set<string>
  injections: Injection[]
}

class EventHub {
  readonly #listeners = new Set<{ event: string; fn: (payload: unknown) => void }>()
  on(event: string, fn: (payload: unknown) => void): () => void {
    const listener = { event, fn }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
  emit(event: string, payload?: unknown): void {
    for (const l of [...this.#listeners]) {
      if (l.event !== event) continue
      try {
        l.fn(payload)
      } catch {
        /* a listener must never break the emitter */
      }
    }
  }
}

function toDisposable(result: Cleanup): Disposable | null {
  if (!result) return null
  if (typeof result === 'function') return { dispose: result }
  return result
}

class ContextImpl implements Context {
  readonly scope: string
  readonly #parent: ContextImpl | null
  readonly #hub: EventHub
  readonly #services = new Map<string, unknown>()
  readonly #entries: Entry[] = []
  readonly #contextInjections: Injection[] = []
  readonly #effects: Disposable[] = []
  readonly #children = new Set<ContextImpl>()
  readonly #pending: Promise<void>[] = []
  #current: Entry | null = null
  #disposed = false
  #evaluating = false
  #dirty = false

  constructor(parent: ContextImpl | null, hub: EventHub, scope: string) {
    this.#parent = parent
    this.#hub = hub
    this.scope = scope
    if (parent) parent.#children.add(this)
  }

  get disposed(): boolean {
    return this.#disposed
  }

  // --------------------------------------------------------------- services

  has(name: string): boolean {
    if (this.#services.has(name)) return true
    return this.#parent ? this.#parent.has(name) : false
  }

  get<T>(name: string): T {
    if (this.#services.has(name)) return this.#services.get(name) as T
    if (this.#parent) return this.#parent.get<T>(name)
    throw new Error(`service not found: ${name}`)
  }

  provide<T>(name: string, value: T): void {
    if (this.has(name)) {
      throw new Error(`service already provided: ${name} (use isolate() to shadow it in a scope)`)
    }
    this.#set(name, value)
  }

  isolate<T>(name: string, value: T): void {
    this.#set(name, value)
  }

  #set(name: string, value: unknown): void {
    this.#services.set(name, value)
    this.#current?.provided.add(name)
    this.#notify()
  }

  // -------------------------------------------------------------- lifecycle

  effect(fn: () => Cleanup): void {
    const disposable = toDisposable(fn())
    if (!disposable) return
    if (this.#current) this.#current.disposables.push(disposable)
    else this.#effects.push(disposable)
  }

  on(event: string, fn: (payload: unknown) => void): void {
    this.effect(() => this.#hub.on(event, fn))
  }

  emit(event: string, payload?: unknown): void {
    this.#hub.emit(event, payload)
  }

  inject(deps: string[], fn: (ctx: Context) => Cleanup): Disposable {
    const injection: Injection = { deps, fn, disposable: null, owner: this.#current }
    if (injection.owner) injection.owner.injections.push(injection)
    else this.#contextInjections.push(injection)

    this.#evaluateInjection(injection)

    return {
      dispose: () => {
        this.#disposeInjection(injection)
        if (injection.owner) {
          injection.owner.injections = injection.owner.injections.filter((i) => i !== injection)
        } else {
          const i = this.#contextInjections.indexOf(injection)
          if (i >= 0) this.#contextInjections.splice(i, 1)
        }
      },
    }
  }

  #evaluateInjection(injection: Injection): void {
    if (this.#disposed) return
    const ready = injection.deps.every((d) => this.has(d))
    if (ready && !injection.disposable) {
      injection.disposable = toDisposable(injection.fn(this))
    } else if (!ready && injection.disposable) {
      this.#disposeInjection(injection)
    }
  }

  #disposeInjection(injection: Injection): void {
    if (!injection.disposable) return
    try {
      const p = injection.disposable.dispose()
      if (p) this.#pending.push(p)
    } catch {
      /* ignore */
    }
    injection.disposable = null
  }

  // ---------------------------------------------------------------- plugins

  plugin<C>(plugin: Plugin<C>, config?: unknown): Disposable {
    if (this.#disposed) throw new Error(`context disposed: ${this.scope}`)

    let parsed = config as C
    let configError: string | undefined
    if (plugin.Config) {
      try {
        parsed = plugin.Config.parse(config ?? {})
      } catch (err) {
        configError = `config: ${(err as Error).message}`
      }
    }

    const entry: Entry = {
      plugin: plugin as Plugin,
      config: parsed,
      status: 'waiting',
      disposables: [],
      provided: new Set(),
      injections: [],
    }
    if (configError) entry.error = configError
    this.#entries.push(entry)

    if (configError) entry.status = 'failed'
    else this.#activate(entry)
    this.#notify()

    return {
      dispose: () => {
        this.#teardown(entry)
        entry.status = 'disposed'
        this.#notify()
      },
    }
  }

  #depsReady(entry: Entry): boolean {
    return (entry.plugin.inject ?? []).every((d) => this.has(d))
  }

  #activate(entry: Entry): void {
    if (!this.#depsReady(entry)) {
      entry.status = 'waiting'
      return
    }
    // Mark active BEFORE apply: `apply` may provide a service, which triggers
    // evaluation, and a 'waiting' entry would otherwise re-enter activation.
    entry.status = 'active'
    const previous = this.#current
    this.#current = entry
    try {
      const disposable = toDisposable(entry.plugin.apply(this, entry.config as never))
      if (disposable) entry.disposables.push(disposable)
      entry.error = undefined
    } catch (err) {
      entry.status = 'failed'
      entry.error = (err as Error)?.message ?? String(err)
      this.#teardown(entry)
    } finally {
      this.#current = previous
    }
  }

  #teardown(entry: Entry): void {
    for (const injection of entry.injections) this.#disposeInjection(injection)
    entry.injections = []
    for (const d of [...entry.disposables].reverse()) {
      try {
        const p = d.dispose()
        if (p) this.#pending.push(p)
      } catch {
        /* ignore */
      }
    }
    entry.disposables = []
    for (const name of entry.provided) this.#services.delete(name)
    entry.provided.clear()
  }

  // ------------------------------------------------------------ evaluation

  #notify(): void {
    if (this.#evaluating) {
      this.#dirty = true
      return
    }
    this.#evaluating = true
    try {
      do {
        this.#dirty = false
        this.#evaluate()
      } while (this.#dirty)
    } finally {
      this.#evaluating = false
    }
  }

  #subtree(): ContextImpl[] {
    const out: ContextImpl[] = [this]
    for (const child of this.#children) out.push(...child.#subtree())
    return out
  }

  #evaluate(): void {
    for (const ctx of this.#subtree()) {
      if (ctx.#disposed) continue
      for (const entry of ctx.#entries) {
        if (entry.status === 'disposed' || entry.status === 'failed') continue
        const ready = ctx.#depsReady(entry)
        if (ready && entry.status === 'waiting') ctx.#activate(entry)
        else if (!ready && entry.status === 'active') {
          ctx.#teardown(entry)
          entry.status = 'waiting'
        }
      }
      for (const injection of ctx.#contextInjections) ctx.#evaluateInjection(injection)
      for (const entry of ctx.#entries) {
        for (const injection of entry.injections) ctx.#evaluateInjection(injection)
      }
    }
  }

  // ------------------------------------------------------------------ scope

  fork(overrides?: Record<string, unknown>): Context {
    const child = new ContextImpl(this, this.#hub, `${this.scope}/${String(overrides?.scope ?? 'fork')}`)
    if (overrides) {
      for (const [name, value] of Object.entries(overrides)) {
        if (name === 'scope') continue
        child.#services.set(name, value)
      }
    }
    child.#notify()
    return child
  }

  plugins(): PluginRecord[] {
    return this.#entries.map((e) => ({ name: e.plugin.name, status: e.status, error: e.error }))
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    for (const child of [...this.#children]) await child.dispose()
    this.#children.clear()
    for (const entry of [...this.#entries].reverse()) {
      this.#teardown(entry)
      entry.status = 'disposed'
    }
    for (const injection of this.#contextInjections) this.#disposeInjection(injection)
    this.#contextInjections.length = 0
    for (const d of [...this.#effects].reverse()) {
      try {
        const p = d.dispose()
        if (p) await p
      } catch {
        /* ignore */
      }
    }
    this.#effects.length = 0
    await Promise.allSettled(this.#pending)
    this.#pending.length = 0
  }
}

export function createContext(scope = 'root'): Context {
  return new ContextImpl(null, new EventHub(), scope)
}
