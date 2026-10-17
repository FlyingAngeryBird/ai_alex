import { randomUUID } from 'node:crypto'
import type { R1Database } from './database.js'

/** A deletion/correction revokes every earlier model context, including derived replies.
 * Raw history remains visible. This marker never suppresses unrelated valid memories. */
export function invalidateMemoryContext(db: R1Database, deletionEpoch: number): void {
  const { last } = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS last FROM messages').get() as { last: number }
  db.prepare('INSERT INTO event_log (event_id, occurred_at, kind, owner_id, payload_json) VALUES (?, ?, ?, ?, ?)')
    .run(randomUUID(), new Date().toISOString(), 'memory_context_invalidated', null,
      JSON.stringify({ throughMessageRowId: last, deletionEpoch }))
}

export function memoryContextCutoff(db: R1Database): number {
  const rows = db.prepare("SELECT payload_json FROM event_log WHERE kind = 'memory_context_invalidated'").all() as { payload_json: string }[]
  return rows.reduce((cutoff, row) => {
    const value = JSON.parse(row.payload_json).throughMessageRowId
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('MEMORY_CONTEXT_MARKER_INVALID')
    return Math.max(cutoff, value)
  }, 0)
}

export function memoryContextEpoch(db: R1Database): number {
  const row = db.prepare("SELECT MAX(json_extract(payload_json, '$.deletionEpoch')) AS epoch FROM event_log WHERE kind = 'memory_context_invalidated'").get() as { epoch: number | null }
  return row.epoch ?? 0
}
