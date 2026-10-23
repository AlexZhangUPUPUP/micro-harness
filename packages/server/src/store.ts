/**
 * Session storage — ROADMAP P4 / ARCHITECTURE.md §7.
 *
 * SQLite is the source of truth for sessions and events; JSONL remains an
 * append-only compatibility export that can rebuild a fresh database. Nothing
 * here imports HTTP: the store is a plain library for CLI, server and tests.
 *
 * Layout:
 *   <dataDir>/sessions/<id>/meta.json     human-readable metadata export
 *   <dataDir>/sessions/<id>/events.jsonl  portable event export
 *   <dataDir>/index.sqlite                canonical event and metadata store
 */

import { Database } from 'bun:sqlite'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { eventText, type TaggedEvent } from '@micro-harness/core'

export interface SessionMeta {
  id: string
  title: string
  model: string
  cwd: string
  parentId: string | null
  status: 'active' | 'done' | 'error'
  createdAt: number
  updatedAt: number
  input: number
  output: number
  cost: number
}

export interface SessionSearchHit {
  sessionId: string
  agentId: string
  type: string
  content: string
  title: string
  model: string
}

/** 工具执行账本中的最终可审计状态。 */
export interface ToolExecutionRecord {
  sessionId: string
  agentId: string
  callId: string
  name: string
  status: string
  reason?: string
  output?: string
  updatedAt: number
}

export interface CreateSessionInput {
  id?: string
  title?: string
  model?: string
  cwd?: string
  parentId?: string | null
}

interface SessionRow {
  id: string
  title: string
  model: string
  cwd: string
  parent_id: string | null
  status: string
  created_at: number
  updated_at: number
  input: number
  output: number
  cost: number
}

function toMeta(row: SessionRow): SessionMeta {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    cwd: row.cwd,
    parentId: row.parent_id,
    status: row.status as SessionMeta['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    input: row.input,
    output: row.output,
    cost: row.cost,
  }
}

/** Fold one event into a session header. Pure: returns the next header. */
export function deriveMeta(meta: SessionMeta, event: TaggedEvent): SessionMeta {
  const ev = event.event
  const next: SessionMeta = { ...meta, updatedAt: Date.now() }
  // Sub-agent events flow through the same stream, but only the session's own
  // agent (`main`) may define its header or mark it finished.
  const isMain = event.agentId === 'main'
  switch (ev.type) {
    case 'session.start':
      if (isMain) {
        next.model = ev.model
        next.cwd = ev.cwd
      }
      break
    case 'user.message':
      if (!next.title) next.title = ev.text.replace(/\s+/g, ' ').trim().slice(0, 100)
      break
    case 'usage':
      // every agent's spend counts toward the session total
      next.input += ev.input
      next.output += ev.output
      next.cost += ev.cost ?? 0
      break
    case 'turn.end':
      if (isMain) next.status = 'done'
      break
    case 'error':
      if (isMain && ev.fatal) next.status = 'error'
      break
    default:
      break
  }
  return next
}

/** Turn a user query into a safe FTS5 MATCH expression (AND of quoted terms). */
export function ftsMatch(query: string): string | null {
  const terms = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
  return terms.length ? terms.join(' ') : null
}

export class SessionStore {
  readonly dataDir: string
  readonly sessionsDir: string
  readonly db: Database

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.sessionsDir = path.join(dataDir, 'sessions')
    mkdirSync(this.sessionsDir, { recursive: true })
    this.db = new Database(path.join(dataDir, 'index.sqlite'))
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.#migrate()
  }

  #migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL DEFAULT '',
        model      TEXT NOT NULL DEFAULT '',
        cwd        TEXT NOT NULL DEFAULT '',
        parent_id  TEXT,
        status     TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        input      INTEGER NOT NULL DEFAULT 0,
        output     INTEGER NOT NULL DEFAULT 0,
        cost       REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        rowid_idx  INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id   TEXT NOT NULL,
        parent_id  TEXT,
        seq        INTEGER NOT NULL,
        t          INTEGER NOT NULL,
        type       TEXT NOT NULL,
        data       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, rowid_idx);
      CREATE INDEX IF NOT EXISTS idx_events_identity ON events(session_id, agent_id, seq);
      CREATE TABLE IF NOT EXISTS tool_executions (
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        output TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, agent_id, call_id)
      );
      CREATE TABLE IF NOT EXISTS store_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        session_id UNINDEXED,
        agent_id   UNINDEXED,
        type       UNINDEXED,
        content
      );
    `)
    // 版本号用于后续 schema migration；当前版本只增加索引和元数据表，不改写已有事件。
    const version = this.db.query<{ value: string }, [string]>('SELECT value FROM store_meta WHERE key = ?').get('schema_version')
    if (!version) this.db.query('INSERT INTO store_meta (key, value) VALUES (?, ?)').run('schema_version', '3')
    else if (Number(version.value) < 3) this.db.query('UPDATE store_meta SET value = ? WHERE key = ?').run('3', 'schema_version')
    else if (Number(version.value) > 3) throw new Error(`unsupported storage schema: ${version.value}`)
  }

  dir(id: string): string {
    return path.join(this.sessionsDir, id)
  }

  eventsFile(id: string): string {
    return path.join(this.dir(id), 'events.jsonl')
  }

  metaFile(id: string): string {
    return path.join(this.dir(id), 'meta.json')
  }

  create(input: CreateSessionInput = {}): SessionMeta {
    const now = Date.now()
    const meta: SessionMeta = {
      id: input.id ?? crypto.randomUUID(),
      title: input.title ?? '',
      model: input.model ?? '',
      cwd: input.cwd ?? '',
      parentId: input.parentId ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      input: 0,
      output: 0,
      cost: 0,
    }
    if (this.has(meta.id)) throw new Error(`session already exists: ${meta.id}`)
    this.#insertMeta(meta)
    mkdirSync(this.dir(meta.id), { recursive: true })
    writeFileSync(this.metaFile(meta.id), JSON.stringify(meta, null, 2))
    writeFileSync(this.eventsFile(meta.id), '')
    return meta
  }

  get(id: string): SessionMeta | undefined {
    const row = this.db.query<SessionRow, [string]>('SELECT * FROM sessions WHERE id = ?').get(id)
    return row ? toMeta(row) : undefined
  }

  require(id: string): SessionMeta {
    const meta = this.get(id)
    if (!meta) throw new Error(`session not found: ${id}`)
    return meta
  }

  has(id: string): boolean {
    return !!this.get(id)
  }

  list(): SessionMeta[] {
    return this.db
      .query<SessionRow, []>('SELECT * FROM sessions ORDER BY updated_at DESC')
      .all()
      .map(toMeta)
  }

  events(id: string): TaggedEvent[] {
    return this.db
      .query<{ data: string }, [string]>('SELECT data FROM events WHERE session_id = ? ORDER BY rowid_idx')
      .all(id)
      .map((r) => JSON.parse(r.data) as TaggedEvent)
  }

  /** 查询某个会话中已知的工具执行状态，供恢复和审计使用。 */
  toolExecutions(id: string): ToolExecutionRecord[] {
    this.require(id)
    return this.db.query<ToolExecutionRecord, [string]>(
      `SELECT session_id AS sessionId, agent_id AS agentId, call_id AS callId, name, status, reason, output, updated_at AS updatedAt
         FROM tool_executions WHERE session_id = ? ORDER BY updated_at, call_id`,
    ).all(id).map((record) => ({ ...record, reason: record.reason ?? undefined, output: record.output ?? undefined }))
  }

  /** 将 SQLite 主存储重新导出为 JSONL 和元数据文件，修复中断的兼容导出。 */
  exportSession(id: string): void {
    const meta = this.require(id)
    const events = this.events(id)
    mkdirSync(this.dir(id), { recursive: true })
    this.#atomicWrite(this.eventsFile(id), events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''))
    this.#atomicWrite(this.metaFile(id), JSON.stringify(meta, null, 2))
  }

  /** 查询兼容导出的健康状态；SQLite 主存储成功后导出失败不会伪装成事务失败。 */
  exportStatus(id: string): { ok: boolean; error?: string } {
    this.require(id)
    const row = this.db.query<{ value: string }, [string]>('SELECT value FROM store_meta WHERE key = ?').get(`export_error:${id}`)
    return row ? { ok: false, error: row.value } : { ok: true }
  }

  append(id: string, event: TaggedEvent): SessionMeta {
    const write = this.db.transaction(() => {
      const current = this.require(id)
      const next = deriveMeta(current, event)
      this.#insertEvent(id, event)
      this.#insertMeta(next)
      return next
    })
    const next = write()
    // SQLite 提交成功后再更新兼容导出；导出失败不影响主存储可读性。
    this.#appendExport(id, event, next)
    return next
  }

  /** Append many events (used by fork and rebuild paths). */
  appendAll(id: string, events: TaggedEvent[]): SessionMeta {
    const write = this.db.transaction(() => {
      let meta = this.require(id)
      for (const event of events) {
        this.#insertEvent(id, event)
        meta = deriveMeta(meta, event)
      }
      this.#insertMeta(meta)
      return meta
    })
    const meta = write()
    // 批量写入一次性追加，避免每个事件都单独刷新文件。
    if (events.length) {
      try {
        appendFileSync(this.eventsFile(id), events.map((event) => JSON.stringify(event)).join('\n') + '\n')
        this.#atomicWrite(this.metaFile(id), JSON.stringify(meta, null, 2))
        this.#clearExportError(id)
      } catch (error) {
        this.#recordExportFailure(id, error)
      }
    }
    return meta
  }

  update(id: string, patch: Partial<SessionMeta>): SessionMeta {
    const next = { ...this.require(id), ...patch, id, updatedAt: Date.now() }
    this.#insertMeta(next)
    try {
      this.#atomicWrite(this.metaFile(id), JSON.stringify(next, null, 2))
      this.#clearExportError(id)
    } catch (error) {
      this.#recordExportFailure(id, error)
    }
    return next
  }

  renameSession(id: string, title: string): SessionMeta {
    // update() already persists to meta.json + sqlite, so a rename is just a
    // title patch; require() throws if the session is unknown.
    return this.update(id, { title })
  }

  delete(id: string): boolean {
    if (!this.has(id)) return false
    const remove = this.db.transaction(() => {
      this.db.query('DELETE FROM events WHERE session_id = ?').run(id)
      this.db.query('DELETE FROM events_fts WHERE session_id = ?').run(id)
      this.db.query('DELETE FROM tool_executions WHERE session_id = ?').run(id)
      this.db.query('DELETE FROM sessions WHERE id = ?').run(id)
      this.db.query('DELETE FROM store_meta WHERE key = ?').run(`export_error:${id}`)
    })
    remove()
    rmSync(this.dir(id), { recursive: true, force: true })
    return true
  }

  /** Full-text search across every indexed event. */
  search(query: string, limit = 20): SessionSearchHit[] {
    const match = ftsMatch(query)
    if (!match) return []
    return this.db
      .query<{ session_id: string; agent_id: string; type: string; content: string; title: string; model: string }, [string, number]>(
        `SELECT f.session_id, f.agent_id, f.type, f.content,
                COALESCE(s.title, '') AS title, COALESCE(s.model, '') AS model
           FROM events_fts f
           LEFT JOIN sessions s ON s.id = f.session_id
          WHERE events_fts MATCH ?
          LIMIT ?`,
      )
      .all(match, limit)
      .map((r) => ({
        sessionId: r.session_id,
        agentId: r.agent_id,
        type: r.type,
        content: r.content,
        title: r.title,
        model: r.model,
      }))
  }

  /** 重建搜索索引；只有空数据库才从旧 JSONL 导入，避免覆盖已提交的 SQLite 事件。 */
  rebuild(): number {
    const existing = this.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM sessions').get()?.count ?? 0
    return existing ? this.#rebuildFts() : this.#importJsonl()
  }

  close(): void {
    this.db.close()
  }

  /** 只重建 FTS，不触碰 SQLite 事件和会话元数据。 */
  #rebuildFts(): number {
    const rebuild = this.db.transaction(() => {
      this.db.exec('DELETE FROM events_fts;')
      const rows = this.db.query<{ session_id: string; agent_id: string; type: string; data: string }, []>('SELECT session_id, agent_id, type, data FROM events ORDER BY rowid_idx').all()
      for (const row of rows) this.#insertFts(row.session_id, JSON.parse(row.data) as TaggedEvent)
      return rows.length
    })
    return rebuild()
  }

  /** 事务化导入旧 JSONL；解析失败时不会清空或污染现有数据库。 */
  #importJsonl(): number {
    const imports: Array<{ id: string; meta: SessionMeta; events: TaggedEvent[] }> = []
    for (const id of readdirSync(this.sessionsDir)) {
      const metaPath = this.metaFile(id)
      const eventsPath = this.eventsFile(id)
      if (!existsSync(metaPath) || !existsSync(eventsPath)) continue
      let meta = JSON.parse(readFileSync(metaPath, 'utf8')) as SessionMeta
      meta = { ...meta, input: 0, output: 0, cost: 0 }
      const events = readFileSync(eventsPath, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as TaggedEvent)
      for (const event of events) meta = deriveMeta(meta, event)
      imports.push({ id, meta, events })
    }
    const write = this.db.transaction(() => {
      this.db.exec('DELETE FROM events; DELETE FROM events_fts; DELETE FROM sessions;')
      let count = 0
      for (const item of imports) {
        this.#insertMeta({ ...item.meta, input: 0, output: 0, cost: 0 })
        for (const event of item.events) {
          this.#insertEvent(item.id, event)
          count++
        }
        this.#insertMeta(item.meta)
      }
      return count
    })
    const count = write()
    for (const item of imports) this.#atomicWrite(this.metaFile(item.id), JSON.stringify(item.meta, null, 2))
    return count
  }

  #insertMeta(meta: SessionMeta): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO sessions
           (id, title, model, cwd, parent_id, status, created_at, updated_at, input, output, cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meta.id,
        meta.title,
        meta.model,
        meta.cwd,
        meta.parentId,
        meta.status,
        meta.createdAt,
        meta.updatedAt,
        meta.input,
        meta.output,
        meta.cost,
      )
  }

  #insertEvent(sessionId: string, event: TaggedEvent): void {
    this.db
      .query(
        `INSERT INTO events (session_id, agent_id, parent_id, seq, t, type, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sessionId, event.agentId, event.parentId, event.seq, event.t, event.event.type, JSON.stringify(event))
    this.#insertFts(sessionId, event)
    this.#recordToolExecution(sessionId, event)
  }

  /** 从状态和结果事件维护幂等执行账本；重复事件只更新最新观察。 */
  #recordToolExecution(sessionId: string, tagged: TaggedEvent): void {
    const event = tagged.event
    if (event.type !== 'tool.status' && event.type !== 'tool.result') return
    const current = this.db.query<{ name: string; status: string; reason?: string; output?: string }, [string, string, string]>(
      'SELECT name, status, reason, output FROM tool_executions WHERE session_id = ? AND agent_id = ? AND call_id = ?',
    ).get(sessionId, tagged.agentId, event.id)
    const name = event.name
    const status = event.type === 'tool.status' ? event.status : (event.ok ? 'succeeded' : 'failed')
    const reason = event.type === 'tool.status' ? event.reason : current?.reason
    const output = event.type === 'tool.result' ? event.output : current?.output
    this.db.query(
      `INSERT OR REPLACE INTO tool_executions (session_id, agent_id, call_id, name, status, reason, output, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, tagged.agentId, event.id, name, status, reason ?? null, output ?? null, tagged.t)
  }

  /** 为单个事件写入全文索引。 */
  #insertFts(sessionId: string, event: TaggedEvent): void {
    const text = eventText(event.event)
    if (!text) return
    this.db.query('INSERT INTO events_fts (session_id, agent_id, type, content) VALUES (?, ?, ?, ?)').run(sessionId, event.agentId, event.event.type, text)
  }

  /** 兼容导出追加失败时记录可修复状态，避免调用方重复提交主事件。 */
  #appendExport(id: string, event: TaggedEvent, meta: SessionMeta): void {
    try {
      mkdirSync(this.dir(id), { recursive: true })
      appendFileSync(this.eventsFile(id), JSON.stringify(event) + '\n')
      this.#atomicWrite(this.metaFile(id), JSON.stringify(meta, null, 2))
      this.#clearExportError(id)
    } catch (error) {
      this.#recordExportFailure(id, error)
    }
  }

  /** 原子替换导出文件，避免进程中断留下半份 JSON。 */
  #atomicWrite(file: string, content: string): void {
    mkdirSync(path.dirname(file), { recursive: true })
    const temporary = `${file}.tmp-${process.pid}`
    writeFileSync(temporary, content)
    renameSync(temporary, file)
  }

  /** 记录导出失败但不回滚已经提交的 SQLite 事务。 */
  #recordExportFailure(id: string, error: unknown): void {
    const message = String((error as Error)?.message ?? error)
    try {
      this.db.query('INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)').run(`export_error:${id}`, message)
    } catch {
      console.error(`[SessionStore] export failed for ${id}: ${message}`)
    }
  }

  /** 清理已经修复的导出错误。 */
  #clearExportError(id: string): void {
    this.db.query('DELETE FROM store_meta WHERE key = ?').run(`export_error:${id}`)
  }
}
