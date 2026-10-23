import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Database } from 'bun:sqlite'

export interface ArtifactRecord {
  id: string
  sessionId: string
  agentId?: string
  name: string
  mime: string
  size: number
  sha256: string
  createdAt: number
}

/** 会话级产物存储：元数据进 SQLite，内容使用临时文件原子落盘。 */
export class ArtifactStore {
  readonly #db: Database
  readonly #root: string

  constructor(db: Database, dataDir: string) {
    this.#db = db
    this.#root = path.join(dataDir, 'artifacts')
    mkdirSync(this.#root, { recursive: true })
    this.#db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT, name TEXT NOT NULL,
      mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at);`)
  }

  list(sessionId: string): ArtifactRecord[] {
    return this.#db.query<ArtifactRecord, [string]>(
      `SELECT id, session_id AS sessionId, agent_id AS agentId, name, mime, size, sha256, created_at AS createdAt
       FROM artifacts WHERE session_id = ? ORDER BY created_at, id`,
    ).all(sessionId)
  }

  save(sessionId: string, body: Uint8Array, input: { name?: string; mime?: string; agentId?: string } = {}): ArtifactRecord {
    const id = randomUUID()
    const sha256 = createHash('sha256').update(body).digest('hex')
    const record: ArtifactRecord = {
      id, sessionId, agentId: input.agentId, name: input.name?.trim() || id,
      mime: input.mime || 'application/octet-stream', size: body.byteLength, sha256, createdAt: Date.now(),
    }
    const dir = path.join(this.#root, sessionId)
    mkdirSync(dir, { recursive: true })
    const target = this.#path(record)
    const temp = `${target}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, body)
      renameSync(temp, target)
      this.#db.query(
        `INSERT INTO artifacts (id, session_id, agent_id, name, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(record.id, record.sessionId, record.agentId ?? null, record.name, record.mime, record.size, record.sha256, record.createdAt)
      return record
    } catch (error) {
      rmSync(temp, { force: true })
      rmSync(target, { force: true })
      throw error
    }
  }

  get(sessionId: string, id: string): ArtifactRecord | undefined {
    return this.#db.query<ArtifactRecord, [string, string]>(
      `SELECT id, session_id AS sessionId, agent_id AS agentId, name, mime, size, sha256, created_at AS createdAt
       FROM artifacts WHERE session_id = ? AND id = ?`,
    ).get(sessionId, id) ?? undefined
  }

  read(record: ArtifactRecord): Uint8Array {
    const body = readFileSync(this.#path(record))
    if (body.byteLength !== record.size || createHash('sha256').update(body).digest('hex') !== record.sha256) throw new Error('artifact integrity check failed')
    return body
  }

  /** 在完整性校验后返回闭区间字节片段，供大产物断点读取。 */
  readRange(record: ArtifactRecord, start: number, end: number): Uint8Array {
    const body = this.read(record)
    const from = Math.max(0, Math.min(start, body.byteLength))
    const to = Math.max(from, Math.min(end + 1, body.byteLength))
    return body.slice(from, to)
  }

  remove(sessionId: string, id: string): boolean {
    const record = this.get(sessionId, id)
    if (!record) return false
    this.#db.query('DELETE FROM artifacts WHERE session_id = ? AND id = ?').run(sessionId, id)
    rmSync(this.#path(record), { force: true })
    return true
  }

  /** 删除会话时一并清理其产物，避免数据库和磁盘留下孤儿文件。 */
  removeSession(sessionId: string): number {
    const records = this.list(sessionId)
    for (const record of records) rmSync(this.#path(record), { force: true })
    this.#db.query('DELETE FROM artifacts WHERE session_id = ?').run(sessionId)
    rmSync(path.join(this.#root, sessionId), { recursive: true, force: true })
    return records.length
  }

  #path(record: ArtifactRecord): string {
    return path.join(this.#root, record.sessionId, record.id)
  }
}
