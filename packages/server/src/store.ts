/**
 * Session storage — ROADMAP P4 / ARCHITECTURE.md §7.
 *
 * JSONL is the source of truth, one append-only file per session; SQLite is a
 * *derived* index (metadata + FTS5 full-text) that can be deleted and rebuilt
 * from the JSONL files at any time. Nothing here imports HTTP: the store is a
 * plain library so the CLI, server and tests all use the same code.
 *
 * Layout:
 *   <dataDir>/sessions/<id>/meta.json     small, human-readable session header
 *   <dataDir>/sessions/<id>/events.jsonl  every tagged AgentEvent, in order
 *   <dataDir>/index.sqlite                derived index (safe to delete)
 */

import { Database } from 'bun:sqlite'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  switch (ev.type) {
    case 'session.start':
      next.model = ev.model
      next.cwd = ev.cwd
      break
    case 'user.message':
      if (!next.title) next.title = ev.text.replace(/\s+/g, ' ').trim().slice(0, 100)
      break
    case 'usage':
      next.input += ev.input
      next.output += ev.output
      next.cost += ev.cost ?? 0
      break
    case 'turn.end':
      next.status = 'done'
      break
    case 'error':
      if (ev.fatal) next.status = 'error'
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
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        session_id UNINDEXED,
        agent_id   UNINDEXED,
        type       UNINDEXED,
        content
      );
    `)
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
    mkdirSync(this.dir(meta.id), { recursive: true })
    writeFileSync(this.metaFile(meta.id), JSON.stringify(meta, null, 2))
    writeFileSync(this.eventsFile(meta.id), '')
    this.#insertMeta(meta)
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

  append(id: string, event: TaggedEvent): SessionMeta {
    this.require(id)
    appendFileSync(this.eventsFile(id), JSON.stringify(event) + '\n')
    this.#insertEvent(id, event)
    const next = deriveMeta(this.require(id), event)
    writeFileSync(this.metaFile(id), JSON.stringify(next, null, 2))
    this.#insertMeta(next)
    return next
  }

  /** Append many events (used by fork and rebuild paths). */
  appendAll(id: string, events: TaggedEvent[]): SessionMeta {
    let meta = this.require(id)
    for (const event of events) {
      appendFileSync(this.eventsFile(id), JSON.stringify(event) + '\n')
      this.#insertEvent(id, event)
      meta = deriveMeta(meta, event)
    }
    writeFileSync(this.metaFile(id), JSON.stringify(meta, null, 2))
    this.#insertMeta(meta)
    return meta
  }

  update(id: string, patch: Partial<SessionMeta>): SessionMeta {
    const next = { ...this.require(id), ...patch, id, updatedAt: Date.now() }
    writeFileSync(this.metaFile(id), JSON.stringify(next, null, 2))
    this.#insertMeta(next)
    return next
  }

  delete(id: string): boolean {
    if (!this.has(id)) return false
    this.db.query('DELETE FROM events WHERE session_id = ?').run(id)
    this.db.query('DELETE FROM events_fts WHERE session_id = ?').run(id)
    this.db.query('DELETE FROM sessions WHERE id = ?').run(id)
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

  /**
   * Drop the derived index and rebuild it from the JSONL/meta files on disk.
   * This is the "index is disposable" guarantee: the files remain the truth.
   */
  rebuild(): number {
    this.db.exec('DELETE FROM events; DELETE FROM events_fts; DELETE FROM sessions;')
    let count = 0
    for (const id of readdirSync(this.sessionsDir)) {
      const metaPath = this.metaFile(id)
      const eventsPath = this.eventsFile(id)
      if (!existsSync(metaPath) || !existsSync(eventsPath)) continue
      let meta = JSON.parse(readFileSync(metaPath, 'utf8')) as SessionMeta
      this.#insertMeta(meta)
      for (const line of readFileSync(eventsPath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        const event = JSON.parse(line) as TaggedEvent
        this.#insertEvent(id, event)
        meta = deriveMeta(meta, event)
        count++
      }
      writeFileSync(metaPath, JSON.stringify(meta, null, 2))
      this.#insertMeta(meta)
    }
    return count
  }

  close(): void {
    this.db.close()
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
    const text = eventText(event.event)
    if (text) {
      this.db
        .query('INSERT INTO events_fts (session_id, agent_id, type, content) VALUES (?, ?, ?, ?)')
        .run(sessionId, event.agentId, event.event.type, text)
    }
  }
}
