import { test, expect } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { localFs, type DirEntry, type FileSystem } from '../src/fs.ts'
import { dispatch, makeTools } from '../src/tools.ts'

/**
 * A second provider for the same seam: no disk at all. If the tools can run over
 * this, the tool surface really is independent of `node:fs`.
 */
function memoryFs(initial: Record<string, string> = {}): FileSystem {
  const files = new Map<string, string>(Object.entries(initial))
  const norm = (p: string): string => p.replace(/^\.\//, '').replace(/\/+/g, '/')
  return {
    root: '/',
    resolve: (p) => norm(String(p ?? '.')),
    rel: (h) => h,
    read: async (h) => {
      const v = files.get(h)
      if (v === undefined) throw new Error(`ENOENT: ${h}`)
      return v
    },
    write: async (h, content) => {
      files.set(h, content)
    },
    list: async (h) => {
      const prefix = h === '.' || h === '/' || h === '' ? '' : h.replace(/\/$/, '') + '/'
      const out = new Map<string, DirEntry>()
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        const [name, ...more] = rest.split('/')
        if (name) out.set(name, { name, dir: more.length > 0 })
      }
      return [...out.values()]
    },
  }
}

const ctx = (fs: FileSystem): Parameters<typeof dispatch>[3] => ({ cwd: fs.root, allowBash: false, fs })

test('localFs round-trips read, write and list inside its sandbox', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-fs-'))
  try {
    const fs = localFs(dir)
    await fs.write(fs.resolve('a/b.txt'), 'hello')
    expect(await fs.read(fs.resolve('a/b.txt'))).toBe('hello')
    expect(fs.rel(fs.resolve('a/b.txt'))).toBe(path.join('a', 'b.txt'))
    const entries = await fs.list(fs.resolve('a'))
    expect(entries).toEqual([{ name: 'b.txt', dir: false }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('localFs refuses to escape its sandbox', () => {
  const fs = localFs('/tmp/sandbox')
  expect(() => fs.resolve('../etc/passwd')).toThrow(/escapes/)
  expect(() => fs.resolve('/etc/passwd')).toThrow(/escapes/)
  expect(fs.resolve('.')).toBe('/tmp/sandbox')
  expect(fs.resolve('a/../b')).toBe('/tmp/sandbox/b')
})

test('the file tools run unchanged over a different filesystem provider', async () => {
  const fs = memoryFs({ 'notes.md': '# from memory\n' })
  const tools = makeTools()
  const c = ctx(fs)

  // read the in-memory file through the real tool
  const read = await dispatch(tools, 'read_file', JSON.stringify({ path: 'notes.md' }), c)
  expect(read.isError).toBeFalsy()
  expect(read.output).toContain('from memory')

  // write through the real tool, read it back through the provider
  const wrote = await dispatch(tools, 'write_file', JSON.stringify({ path: 'sub/new.txt', content: 'hi' }), c)
  expect(wrote.output).toMatch(/wrote 2 bytes to sub\/new\.txt/)
  expect(await fs.read('sub/new.txt')).toBe('hi')

  // list through the real tool
  const list = await dispatch(tools, 'list_dir', JSON.stringify({ path: '.' }), c)
  expect(list.output).toContain('notes.md')
  expect(list.output).toContain('sub/')

  // and the sandbox rule still comes from the provider, not the tool
  const escape = await dispatch(tools, 'read_file', JSON.stringify({ path: '../../etc/passwd' }), c)
  expect(escape.isError).toBe(true)
})

test('a symlink that leaves the sandbox is rejected, even for a new file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-fs-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'mh-fs-out-'))
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'secret')
    await symlink(outside, path.join(dir, 'link'))
    const fs = localFs(dir)
    expect(() => fs.resolve('link/secret.txt')).toThrow(/symlink/)
    expect(() => fs.resolve('link/new.txt')).toThrow(/symlink/)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('a symlink that stays inside the sandbox is allowed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mh-fs-'))
  try {
    await mkdir(path.join(dir, 'real'))
    await writeFile(path.join(dir, 'real', 'a.txt'), 'a')
    await symlink(path.join(dir, 'real'), path.join(dir, 'alias'))
    const fs = localFs(dir)
    expect(fs.read(fs.resolve('alias/a.txt'))).resolves.toBe('a')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
