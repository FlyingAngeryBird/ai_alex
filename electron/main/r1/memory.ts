import { randomUUID } from 'node:crypto'
import { inTransaction, type R1Database } from './database.js'

export type R1Memory = {
  memoryId: string
  content: string
  category: 'profile' | 'preference' | 'ongoing' | 'conclusion'
  sourceRefs: string[]
  expiresAt: string | null
  version: number
  deletionEpoch: number
}

export type R1MemorySource = { messageId: string; body: string; createdAt: string }
export type R1MemoryPage = { entries: R1Memory[]; page: number; hasMore: boolean }

type MemoryRow = {
  memory_id: string; content: string; category: R1Memory['category']
  source_refs_json: string; expires_at: string | null; version: number
  deletion_epoch: number; deleted_at: string | null
}

function view(row: MemoryRow): R1Memory {
  return { memoryId: row.memory_id, content: row.content, category: row.category,
    sourceRefs: JSON.parse(row.source_refs_json) as string[], expiresAt: row.expires_at,
    version: row.version, deletionEpoch: row.deletion_epoch }
}

export class R1MemoryStore {
  constructor(private readonly db: R1Database) {}

  list(input: { query?: string; page?: number; scope?: 'about' | 'all' } = {}): R1MemoryPage {
    const query = input.query ?? ''
    const page = input.page ?? 0
    const scope = input.scope ?? 'all'
    if (typeof query !== 'string' || [...query].length > 1000 ||
      !Number.isInteger(page) || page < 0 || !['about', 'all'].includes(scope)) {
      throw new Error('INVALID_MEMORY_QUERY')
    }
    const now = new Date().toISOString()
    const escaped = query.trim().replace(/[\\%_]/g, '\\$&')
    const rows = this.db.prepare(`SELECT * FROM memory WHERE deleted_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
      AND content LIKE ? ESCAPE '\\'
      AND (? = 'all' OR category IN ('profile', 'preference'))
      ORDER BY updated_at DESC`)
      .all(now, `%${escaped}%`, scope) as MemoryRow[]
    const active = rows.filter((row) => !this.isSuppressed(row))
    const start = page * 20
    return { entries: active.slice(start, start + 20).map(view), page,
      hasMore: active.length > start + 20 }
  }

  sources(memoryId: string): R1MemorySource[] {
    const row = this.db.prepare('SELECT * FROM memory WHERE memory_id = ? AND deleted_at IS NULL')
      .get(memoryId) as MemoryRow | undefined
    if (!row || this.isSuppressed(row)) throw new Error('MEMORY_NOT_FOUND')
    const refs = JSON.parse(row.source_refs_json) as string[]
    return refs.map((messageId) => {
      const source = this.db.prepare(`SELECT m.message_id, m.body, m.created_at
        FROM messages m JOIN sessions s ON s.session_id = m.session_id
        WHERE m.message_id = ? AND m.role = 'user' AND s.temporary = 0`)
        .get(messageId) as { message_id: string; body: string; created_at: string } | undefined
      if (!source) throw new Error('MEMORY_SOURCE_UNAVAILABLE')
      return { messageId: source.message_id, body: source.body, createdAt: source.created_at }
    })
  }

  addManual(input: { content: string; category: R1Memory['category'] }): R1Memory {
    this.validateContent(input.content, input.category)
    const content = input.content.trim()
    return inTransaction(this.db, () => {
      const sessionId = randomUUID()
      const messageId = randomUUID()
      const now = new Date().toISOString()
      this.db.prepare(`INSERT INTO sessions (session_id, temporary, status, created_at, ended_at)
        VALUES (?, 0, 'memory_source', ?, ?)`).run(sessionId, now, now)
      this.db.prepare(`INSERT INTO messages
        (message_id, session_id, turn_id, role, body, status, created_at)
        VALUES (?, ?, ?, 'user', ?, 'final', ?)`)
        .run(messageId, sessionId, randomUUID(), content, now)
      return this.insertMemory(content, input.category, [messageId], null, now)
    })
  }

  update(input: { memoryId: string; expectedVersion: number; content: string;
    category: R1Memory['category'] }): R1Memory {
    if (typeof input.memoryId !== 'string' || !input.memoryId ||
      !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error('INVALID_MEMORY_PATCH')
    }
    this.validateContent(input.content, input.category)
    return inTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM memory WHERE memory_id = ? AND deleted_at IS NULL')
        .get(input.memoryId) as MemoryRow | undefined
      if (!row || this.isSuppressed(row)) throw new Error('MEMORY_NOT_FOUND')
      if (row.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
      this.db.prepare(`UPDATE memory SET content = ?, category = ?, version = version + 1,
        updated_at = ? WHERE memory_id = ?`)
        .run(input.content.trim(), input.category, new Date().toISOString(), input.memoryId)
      return view(this.db.prepare('SELECT * FROM memory WHERE memory_id = ?')
        .get(input.memoryId) as MemoryRow)
    })
  }

  private validateContent(content: string, category: R1Memory['category']): void {
    if (typeof content !== 'string' || !content.trim() || [...content].length > 1000) {
      throw new Error('INVALID_MEMORY_CONTENT')
    }
    if (!['profile', 'preference', 'ongoing', 'conclusion'].includes(category)) {
      throw new Error('INVALID_MEMORY_CATEGORY')
    }
  }

  private insertMemory(content: string, category: R1Memory['category'],
    sourceMessageIds: string[], expiresAt: string | null, now: string): R1Memory {
    const duplicateRows = this.db.prepare(`SELECT * FROM memory WHERE deleted_at IS NULL
      AND content = ? AND category = ? AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at DESC`).all(content, category, now) as MemoryRow[]
    const duplicate = duplicateRows.find((row) => !this.isSuppressed(row))
    if (duplicate) {
      const existing = JSON.parse(duplicate.source_refs_json) as string[]
      const refs = [...new Set([...existing, ...sourceMessageIds])]
      if (refs.length > 50) throw new Error('MEMORY_SOURCE_LIMIT')
      if (refs.length === existing.length) return view(duplicate)
      this.db.prepare(`UPDATE memory SET source_refs_json = ?, version = version + 1,
        updated_at = ? WHERE memory_id = ?`)
        .run(JSON.stringify(refs), now, duplicate.memory_id)
      return view(this.db.prepare('SELECT * FROM memory WHERE memory_id = ?')
        .get(duplicate.memory_id) as MemoryRow)
    }
    const id = randomUUID()
    this.db.prepare(`INSERT INTO memory
      (memory_id, content, category, source_refs_json, authorization, occurred_at,
       expires_at, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'explicit', ?, ?, 1, ?, ?)`)
      .run(id, content, category, JSON.stringify(sourceMessageIds), now, expiresAt, now, now)
    return view(this.db.prepare('SELECT * FROM memory WHERE memory_id = ?').get(id) as MemoryRow)
  }

  private isSuppressed(row: MemoryRow): boolean {
    if (this.db.prepare('SELECT 1 FROM source_suppression WHERE source_ref = ?')
      .get(row.memory_id)) return true
    const refs = JSON.parse(row.source_refs_json) as string[]
    return refs.some((ref) => Boolean(this.db.prepare(
      'SELECT 1 FROM source_suppression WHERE source_ref = ?').get(ref)))
  }

  currentDeletionEpoch(): number {
    const memory = (this.db.prepare('SELECT MAX(deletion_epoch) AS epoch FROM memory')
      .get() as { epoch: number | null }).epoch ?? 0
    const suppression = (this.db.prepare('SELECT MAX(deletion_epoch) AS epoch FROM source_suppression')
      .get() as { epoch: number | null }).epoch ?? 0
    return Math.max(memory, suppression)
  }

  remember(input: { content: string; category: R1Memory['category']; sourceMessageIds: string[];
    expiresAt?: string | null }): R1Memory {
    this.validateContent(input.content, input.category)
    if (!Array.isArray(input.sourceMessageIds) || !input.sourceMessageIds.length ||
      input.sourceMessageIds.length > 50 ||
      input.sourceMessageIds.some((id) => typeof id !== 'string')) {
      throw new Error('MEMORY_SOURCE_REQUIRED')
    }
    if (input.expiresAt && !Number.isFinite(Date.parse(input.expiresAt))) throw new Error('INVALID_EXPIRY')
    return inTransaction(this.db, () => {
      for (const sourceId of input.sourceMessageIds) {
        const row = this.db.prepare(`SELECT 1 FROM messages m JOIN sessions s ON s.session_id = m.session_id
          WHERE m.message_id = ? AND m.role = 'user' AND s.temporary = 0`).get(sourceId)
        if (!row) throw new Error('MEMORY_SOURCE_NOT_PERSISTED')
        if (this.db.prepare('SELECT 1 FROM source_suppression WHERE source_ref = ?').get(sourceId)) {
          throw new Error('MEMORY_SOURCE_SUPPRESSED')
        }
      }
      const now = new Date().toISOString()
      return this.insertMemory(input.content.trim(), input.category, input.sourceMessageIds,
        input.expiresAt ?? null, now)
    })
  }

  recall(query: string, temporary = false): R1Memory[] {
    if (temporary) return []
    const normalized = query.trim()
    if (!normalized) return []
    const escaped = normalized.replace(/[\\%_]/g, '\\$&')
    const rows = this.db.prepare(`SELECT * FROM memory WHERE deleted_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
      AND content LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT 20`)
      .all(new Date().toISOString(), `%${escaped}%`) as MemoryRow[]
    return rows.filter((row) => !this.isSuppressed(row)).slice(0, 5).map(view)
  }

  forget(memoryId: string, expectedVersion: number): { memoryId: string; deletionEpoch: number } {
    return inTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM memory WHERE memory_id = ?').get(memoryId) as MemoryRow | undefined
      if (!row || row.deleted_at) throw new Error('MEMORY_NOT_FOUND')
      if (row.version !== expectedVersion) throw new Error('VERSION_CONFLICT')
      const maxMemory = (this.db.prepare('SELECT MAX(deletion_epoch) AS epoch FROM memory')
        .get() as { epoch: number | null }).epoch ?? 0
      const maxSuppression = (this.db.prepare('SELECT MAX(deletion_epoch) AS epoch FROM source_suppression')
        .get() as { epoch: number | null }).epoch ?? 0
      const epoch = Math.max(maxMemory, maxSuppression) + 1
      const now = new Date().toISOString()
      this.db.prepare(`UPDATE memory SET deleted_at = ?, deletion_epoch = ?,
        version = version + 1, updated_at = ? WHERE memory_id = ?`)
        .run(now, epoch, now, memoryId)
      this.db.prepare(`INSERT INTO source_suppression (source_ref, deletion_epoch, created_at)
        VALUES (?, ?, ?) ON CONFLICT(source_ref) DO UPDATE SET deletion_epoch = excluded.deletion_epoch`)
        .run(memoryId, epoch, now)
      const topics = this.db.prepare('SELECT topic_id, source_refs_json FROM topics WHERE deleted_at IS NULL')
        .all() as { topic_id: string; source_refs_json: string }[]
      for (const topic of topics) {
        const refs = JSON.parse(topic.source_refs_json) as string[]
        if (refs.includes(memoryId)) {
          this.db.prepare(`UPDATE topics SET deleted_at = ?, deletion_epoch = ?,
            version = version + 1, updated_at = ? WHERE topic_id = ?`)
            .run(now, epoch, now, topic.topic_id)
        }
      }
      this.db.prepare('INSERT INTO event_log (event_id, occurred_at, kind, owner_id, payload_json) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), now, 'memory_forgotten', memoryId, JSON.stringify({ deletionEpoch: epoch }))
      return { memoryId, deletionEpoch: epoch }
    })
  }
}
