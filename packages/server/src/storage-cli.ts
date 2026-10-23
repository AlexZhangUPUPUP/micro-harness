#!/usr/bin/env bun
/** 离线存储维护命令，不加载 Provider、MCP 或模型配置。 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionStore, type SessionMeta } from './store.ts'

interface BackupManifest {
  version: 1
  schemaVersion: 2
  createdAt: number
  sessions: Array<{ meta: SessionMeta; eventCount: number }>
}

const usage = `micro-harness-storage

Usage:
  micro-harness-storage migrate --data-dir <dir>
  micro-harness-storage export --data-dir <dir> --out <backup-dir>
  micro-harness-storage restore --from <backup-dir> --data-dir <empty-dir>
`

/** 读取简单的命令行选项；存储命令不依赖模型 CLI 的参数解析。 */
function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  return args[index + 1]
}

/** 计算默认数据目录，与服务端环境变量保持一致。 */
function defaultDataDir(): string {
  return path.resolve(process.env.MICRO_DATA_DIR ?? path.join(os.homedir(), '.micro-harness'))
}

/** 将完整 SQLite 会话导出为可移植的版本化备份目录。 */
export function exportBackup(dataDir: string, outputDir: string): BackupManifest {
  if (existsSync(outputDir) && readdirSync(outputDir).length) throw new Error(`backup directory is not empty: ${outputDir}`)
  mkdirSync(outputDir, { recursive: true })
  const store = new SessionStore(dataDir)
  try {
    const sessions = store.list().map((meta) => {
      const events = store.events(meta.id)
      const dir = path.join(outputDir, 'sessions', meta.id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
      writeFileSync(path.join(dir, 'events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''))
      return { meta, eventCount: events.length }
    })
    const manifest: BackupManifest = { version: 1, schemaVersion: 2, createdAt: Date.now(), sessions }
    writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    return manifest
  } finally {
    store.close()
  }
}

/** 从备份目录导入到空目标目录；失败时清理新建目标。 */
export function restoreBackup(inputDir: string, dataDir: string): BackupManifest {
  if (!existsSync(path.join(inputDir, 'manifest.json'))) throw new Error('manifest.json is missing')
  if (existsSync(dataDir) && readdirSync(dataDir).length) throw new Error(`target directory is not empty: ${dataDir}`)
  const manifest = JSON.parse(readFileSync(path.join(inputDir, 'manifest.json'), 'utf8')) as BackupManifest
  if (manifest.version !== 1 || manifest.schemaVersion !== 2 || !Array.isArray(manifest.sessions)) throw new Error('unsupported backup manifest')
  mkdirSync(dataDir, { recursive: true })
  try {
    for (const item of manifest.sessions) {
      const source = path.join(inputDir, 'sessions', item.meta.id)
      const target = path.join(dataDir, 'sessions', item.meta.id)
      const meta = JSON.parse(readFileSync(path.join(source, 'meta.json'), 'utf8')) as SessionMeta
      const events = readFileSync(path.join(source, 'events.jsonl'), 'utf8')
      if (meta.id !== item.meta.id || events.split('\n').filter(Boolean).length !== item.eventCount) throw new Error(`backup session is inconsistent: ${item.meta.id}`)
      mkdirSync(target, { recursive: true })
      writeFileSync(path.join(target, 'meta.json'), JSON.stringify(meta, null, 2))
      writeFileSync(path.join(target, 'events.jsonl'), events)
    }
    const store = new SessionStore(dataDir)
    try {
      const count = store.rebuild()
      if (count !== manifest.sessions.reduce((sum, item) => sum + item.eventCount, 0)) throw new Error('restored event count mismatch')
    } finally {
      store.close()
    }
    return manifest
  } catch (error) {
    rmSync(dataDir, { recursive: true, force: true })
    throw error
  }
}

/** 执行迁移、导出或恢复，并以 JSON 输出结果供脚本消费。 */
export function main(args: string[]): void {
  const command = args[0]
  if (!command || command === '--help' || command === '-h') {
    console.log(usage)
    return
  }
  const dataDir = path.resolve(option(args, '--data-dir') ?? defaultDataDir())
  if (command === 'migrate') {
    const store = new SessionStore(dataDir)
    try {
      const eventCount = store.rebuild()
      console.log(JSON.stringify({ command, dataDir, schemaVersion: 2, sessions: store.list().length, events: eventCount }))
    } finally {
      store.close()
    }
    return
  }
  if (command === 'export') {
    const output = option(args, '--out')
    if (!output) throw new Error('--out is required')
    const manifest = exportBackup(dataDir, path.resolve(output))
    console.log(JSON.stringify({ command, dataDir, output: path.resolve(output), sessions: manifest.sessions.length, events: manifest.sessions.reduce((sum, item) => sum + item.eventCount, 0) }))
    return
  }
  if (command === 'restore') {
    const input = option(args, '--from')
    if (!input) throw new Error('--from is required')
    const manifest = restoreBackup(path.resolve(input), dataDir)
    console.log(JSON.stringify({ command, dataDir, sessions: manifest.sessions.length, events: manifest.sessions.reduce((sum, item) => sum + item.eventCount, 0) }))
    return
  }
  throw new Error(`unknown storage command: ${command}`)
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(String((error as Error)?.message ?? error))
    process.exitCode = 1
  }
}
