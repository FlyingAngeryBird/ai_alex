import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { inTransaction, openR1Database, R1_SCHEMA_VERSION, type R1Database } from './database.js'

function validateBackup(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version < 1 || version > R1_SCHEMA_VERSION) throw new Error(`BACKUP_SCHEMA_UNSUPPORTED:${version}`)
    const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
    if (integrity !== 'ok') throw new Error('BACKUP_INTEGRITY_FAILED')
    for (const table of ['memory', 'topics', 'source_suppression', 'items', 'reminders']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
        throw new Error(`BACKUP_MISSING_TABLE:${table}`)
      }
    }
  } finally { db.close() }
}

export async function createR1Backup(db: R1Database, destination: string): Promise<void> {
  if (existsSync(destination)) throw new Error('BACKUP_ALREADY_EXISTS')
  mkdirSync(dirname(destination), { recursive: true })
  const temporary = `${destination}.tmp`
  try {
    await backup(db, temporary)
    validateBackup(temporary)
    chmodSync(temporary, 0o600)
    renameSync(temporary, destination)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

type DeletedRow = { id: string; deletion_epoch: number }
type SuppressionRow = { source_ref: string; deletion_epoch: number }

function preserveSuppression(current: R1Database, restored: R1Database): void {
  const suppressions = current.prepare('SELECT source_ref, deletion_epoch FROM source_suppression')
    .all() as SuppressionRow[]
  const deletedMemories = current.prepare('SELECT memory_id AS id, deletion_epoch FROM memory WHERE deleted_at IS NOT NULL')
    .all() as DeletedRow[]
  const deletedTopics = current.prepare('SELECT topic_id AS id, deletion_epoch FROM topics WHERE deleted_at IS NOT NULL')
    .all() as DeletedRow[]
  const all = [...suppressions, ...deletedMemories.map((row) => ({ source_ref: row.id, deletion_epoch: row.deletion_epoch })),
    ...deletedTopics.map((row) => ({ source_ref: row.id, deletion_epoch: row.deletion_epoch }))]
  if (!all.length) return

  inTransaction(restored, () => {
    const insert = restored.prepare(`INSERT INTO source_suppression (source_ref, deletion_epoch, created_at)
      VALUES (?, ?, ?) ON CONFLICT(source_ref) DO UPDATE SET
      deletion_epoch = MAX(source_suppression.deletion_epoch, excluded.deletion_epoch)`)
    const now = new Date().toISOString()
    for (const row of all) insert.run(row.source_ref, Math.max(1, row.deletion_epoch), now)
    const active = new Map((restored.prepare('SELECT source_ref, deletion_epoch FROM source_suppression')
      .all() as SuppressionRow[]).map((row) => [row.source_ref, row.deletion_epoch]))

    for (const table of ['memory', 'topics'] as const) {
      const idColumn = table === 'memory' ? 'memory_id' : 'topic_id'
      const rows = restored.prepare(`SELECT ${idColumn} AS id, source_refs_json, deletion_epoch
        FROM ${table} WHERE deleted_at IS NULL`).all() as {
          id: string; source_refs_json: string; deletion_epoch: number
        }[]
      const suppress = restored.prepare(`UPDATE ${table} SET deleted_at = ?, deletion_epoch = ? WHERE ${idColumn} = ?`)
      for (const row of rows) {
        const refs = JSON.parse(row.source_refs_json) as unknown
        if (!Array.isArray(refs) || !refs.every((ref) => typeof ref === 'string')) {
          throw new Error('BACKUP_SOURCE_REFS_INVALID')
        }
        const epoch = Math.max(active.get(row.id) ?? 0,
          ...refs.map((ref) => active.get(ref as string) ?? 0))
        if (epoch > 0) suppress.run(now, Math.max(row.deletion_epoch, epoch), row.id)
      }
    }
  })
}

/** Run only after the R1 app has quit. Returns a rollback copy of the pre-restore database. */
export function restoreR1BackupOffline(currentPath: string, backupPath: string): string {
  if (!existsSync(currentPath)) throw new Error('CURRENT_DATABASE_MISSING')
  validateBackup(backupPath)
  const current = new DatabaseSync(currentPath)
  const stagedPath = `${currentPath}.restore.tmp`
  const rollbackPath = `${currentPath}.pre-restore-${Date.now()}`
  let staged: DatabaseSync | null = null
  try {
    const version = (current.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version !== R1_SCHEMA_VERSION) throw new Error('CURRENT_SCHEMA_UNSUPPORTED')
    current.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    copyFileSync(backupPath, stagedPath)
    staged = openR1Database(stagedPath)
    preserveSuppression(current, staged)
    staged.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    staged.close()
    staged = null
    validateBackup(stagedPath)
    current.close()
    copyFileSync(currentPath, rollbackPath)
    chmodSync(rollbackPath, 0o600)
    renameSync(stagedPath, currentPath)
    chmodSync(currentPath, 0o600)
    return rollbackPath
  } catch (error) {
    try { staged?.close() } catch { /* preserve original error */ }
    try { current.close() } catch { /* preserve original error */ }
    rmSync(stagedPath, { force: true })
    throw error
  }
}
