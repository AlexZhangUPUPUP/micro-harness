/**
 * The filesystem is a **capability seam**, not a direct dependency.
 *
 * The file tools depend on this interface rather than on `node:fs`, so the whole
 * environment can be swapped — local disk · a git worktree · a remote sandbox · an
 * in-memory double in tests — **without changing the tool surface the model sees**.
 * That is the useful half of "everything is a plugin": seams, not a runtime
 * container. See docs/design-comparison.md for why we stopped there.
 *
 * A handle returned by `resolve()` is opaque to the tools: they only ever pass it
 * back to `read`/`write`/`list`/`rel`, which is what lets a non-local provider
 * (a container, an SSH host, a map in memory) implement the same contract.
 */

import { promises as nodeFs, realpathSync } from 'node:fs'
import path from 'node:path'

export interface DirEntry {
  name: string
  dir: boolean
}

export interface FileSystem {
  /** Root of the sandbox — also the working directory the shell runs in. */
  readonly root: string
  /** Resolve a model-supplied path to a handle. Throws when it escapes the sandbox. */
  resolve(p: unknown): string
  /** A human-readable path, for tool output. */
  rel(handle: string): string
  read(handle: string): Promise<string>
  write(handle: string, content: string): Promise<void>
  list(handle: string): Promise<DirEntry[]>
}

/** The default provider: the real filesystem, sandboxed to one directory. */
export function localFs(root: string): FileSystem {
  const base = path.resolve(root)

  /** realpath of the deepest existing ancestor, with the missing tail re-appended. */
  const realpathDeep = (p: string): string => {
    let current = p
    const tail: string[] = []
    for (;;) {
      try {
        const real = realpathSync(current)
        return tail.length ? path.join(real, ...tail.reverse()) : real
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
        const parent = path.dirname(current)
        if (parent === current) return p
        tail.push(path.basename(current))
        current = parent
      }
    }
  }

  const realBase = realpathDeep(base)
  const insideLogical = (p: string): boolean => p === base || p.startsWith(base + path.sep)
  const insideReal = (p: string): boolean => p === realBase || p.startsWith(realBase + path.sep)

  const resolve = (p: unknown): string => {
    const abs = path.resolve(base, String(p ?? '.'))
    if (!insideLogical(abs)) {
      throw new Error(`path escapes the working directory: ${String(p)}`)
    }
    // A lexically-inside path can still leave through a symlink; check where it
    // really lands. `realpathDeep` also covers a file that does not exist yet by
    // resolving its deepest existing ancestor.
    if (!insideReal(realpathDeep(abs))) {
      throw new Error(`path escapes the working directory via a symlink: ${String(p)}`)
    }
    return abs
  }
  return {
    root: base,
    resolve,
    rel: (handle) => {
      const r = path.relative(base, handle)
      return r === '' ? '.' : r
    },
    read: (handle) => nodeFs.readFile(handle, 'utf8'),
    write: async (handle, content) => {
      await nodeFs.mkdir(path.dirname(handle), { recursive: true })
      await nodeFs.writeFile(handle, content, 'utf8')
    },
    list: async (handle) => {
      const entries = await nodeFs.readdir(handle, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, dir: e.isDirectory() }))
    },
  }
}
