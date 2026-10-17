import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { openR1Database, inTransaction, type R1Database } from './database.js'
import { R1MemoryStore } from './memory.js'
import { R1Topics } from './topics.js'
import { invalidateMemoryContext } from './memoryContext.js'

export const cleanupScopes = ['history', 'memory', 'items', 'music', 'work'] as const
export type CleanupScope = typeof cleanupScopes[number]
export type CleanupSelection = { scopes: CleanupScope[]; sessionId?: string }
export function checkCleanupSelection(input: unknown): CleanupSelection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('DATA_SCOPE_REQUIRED')
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !['scopes', 'sessionId'].includes(key)) || !Array.isArray(value.scopes) || !value.scopes.length ||
    value.scopes.some(scope => !(cleanupScopes as readonly unknown[]).includes(scope)) || new Set(value.scopes).size !== value.scopes.length) throw new Error('DATA_SCOPE_REQUIRED')
  if (value.sessionId !== undefined && (typeof value.sessionId !== 'string' || !value.sessionId || value.sessionId.length > 200 || value.scopes.length !== 1 || value.scopes[0] !== 'history')) throw new Error('DATA_SCOPE_REQUIRED')
  return { scopes: [...value.scopes] as CleanupScope[], ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}) }
}
/** Offline only: callers stop all services and preserve a validated copy first. */
export function cleanupFingerprint(db: R1Database, selection: CleanupSelection): string {
  const hash = createHash('sha256')
  const rows = (sql: string, ...args: string[]) => hash.update(JSON.stringify(db.prepare(sql).all(...args)))
  for (const scope of selection.scopes) {
    hash.update(scope)
    if (scope === 'history') rows(`SELECT m.* FROM messages m JOIN sessions s ON s.session_id=m.session_id
      WHERE s.temporary=0 AND s.status<>'memory_source' ${selection.sessionId ? 'AND s.session_id=?' : ''} ORDER BY m.rowid`, ...(selection.sessionId ? [selection.sessionId] : []))
    else if (scope === 'memory') { rows('SELECT * FROM memory ORDER BY rowid'); rows('SELECT * FROM topics ORDER BY rowid') }
    else if (scope === 'items') { rows('SELECT * FROM items ORDER BY rowid'); rows('SELECT * FROM reminders ORDER BY rowid'); rows('SELECT focus_id,duration_sec FROM focus ORDER BY rowid') }
    else if (scope === 'music') for (const table of ['music_favorites','music_queue','music_feedback','music_search_history']) rows(`SELECT * FROM ${table} ORDER BY rowid`)
    else { rows('SELECT task_id,goal,goal_version,constraints_json,asset_release_id FROM agent_tasks ORDER BY rowid'); rows('SELECT * FROM artifacts ORDER BY rowid'); rows('SELECT * FROM artifact_versions ORDER BY rowid'); rows('SELECT * FROM receipts WHERE task_id IS NOT NULL ORDER BY rowid') }
  }
  return hash.digest('hex')
}
export function cleanupR1DataOffline(path: string, selection: CleanupSelection, rollbackPath: string, expectedFingerprint: string): void {
  const db = openR1Database(path)
  try {
    writeFileSync(rollbackPath, '', { mode: 0o600, flag: 'wx' })
    db.prepare('VACUUM INTO ?').run(rollbackPath)
    inTransaction(db, () => {
      if (cleanupFingerprint(db,selection)!==expectedFingerprint) throw new Error('DATA_CHANGED_REVIEW_AGAIN')
      const now = new Date().toISOString(), scopes = new Set(selection.scopes)
      // Clear working model context before deleting rows, retaining its high-water mark.
      const epoch = new R1MemoryStore(db).currentDeletionEpoch() + 1
      invalidateMemoryContext(db, epoch)
      if (scopes.has('memory')) {
        const store = new R1MemoryStore(db)
        for (const row of db.prepare('SELECT memory_id,version FROM memory WHERE deleted_at IS NULL').all() as { memory_id: string; version: number }[]) store.forget(row.memory_id, row.version)
        const topics = new R1Topics(db)
        for (const row of db.prepare('SELECT topic_id,version FROM topics WHERE deleted_at IS NULL').all() as { topic_id: string; version: number }[]) topics.forget({ topicId: row.topic_id, expectedVersion: row.version })
        db.prepare('UPDATE memory_policy SET version=version+1,authorized_after_rowid=(SELECT COALESCE(MAX(rowid),0) FROM messages),updated_at=? WHERE id=1').run(now)
      }
      if (scopes.has('history')) {
        const sessions = selection.sessionId
          ? db.prepare("SELECT session_id FROM sessions WHERE session_id=? AND temporary=0 AND status<>'memory_source'").all(selection.sessionId)
          : db.prepare("SELECT session_id FROM sessions WHERE temporary=0 AND status<>'memory_source'").all()
        if (selection.sessionId && !sessions.length) throw new Error('SESSION_NOT_FOUND')
        for (const row of sessions) {
          db.prepare('DELETE FROM messages WHERE session_id=?').run(row.session_id!)
          // Task FK identities survive; empty session shells have no history content.
          db.prepare("UPDATE sessions SET status='ended',ended_at=? WHERE session_id=?").run(now, row.session_id!)
        }
      }
      if (scopes.has('items')) {
        db.exec('DELETE FROM receipts WHERE task_id IS NULL AND (entity_id IN (SELECT item_id FROM items) OR entity_id IN (SELECT reminder_id FROM reminders) OR entity_id IN (SELECT focus_id FROM focus))')
        db.exec('DELETE FROM deliveries; DELETE FROM reminders; DELETE FROM items; DELETE FROM focus')
      }
      if (scopes.has('music')) {
        db.exec('DELETE FROM music_favorites; DELETE FROM music_queue; DELETE FROM music_feedback; DELETE FROM music_search_history')
      }
      if (scopes.has('work')) {
        db.exec('DELETE FROM receipts WHERE task_id IS NOT NULL; DELETE FROM task_runs; DELETE FROM agent_tasks; DELETE FROM artifact_versions; DELETE FROM artifacts')
      }
      // No old uncompleted task may silently replay against cleared sources.
      db.prepare("UPDATE agent_tasks SET status='needs_resume',updated_at=? WHERE status IN ('accepted','running','validating','paused')").run(now)
      db.prepare('INSERT INTO event_log VALUES(?,?,?,?,?)').run(randomUUID(), now, 'data_cleared', null, JSON.stringify({ scopes: selection.scopes, singleSession: !!selection.sessionId }))
      if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('BACKUP_RELATIONS_INVALID')
    })
  } finally { db.close() }
}
