import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { inTransaction, openR1Database, R1_SCHEMA_VERSION, type R1Database } from './database.js'
import { R1MemoryStore } from './memory.js'
import { invalidateMemoryContext } from './memoryContext.js'

export function validateBackup(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version < 1 || version > R1_SCHEMA_VERSION) throw new Error(`BACKUP_SCHEMA_UNSUPPORTED:${version}`)
    const integrity = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
    if (integrity !== 'ok') throw new Error('BACKUP_INTEGRITY_FAILED')
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('BACKUP_RELATIONS_INVALID')
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
  const temporary = `${destination}.tmp-${randomUUID()}`
  try {
    writeFileSync(temporary, '', { mode: 0o600, flag: 'wx' })
    await backup(db, temporary)
    // Legacy migration kept its original JSON for rollback. That JSON is not a
    // credential contract and must never be copied into a user content export.
    const exported = new DatabaseSync(temporary)
    try { exported.exec("UPDATE legacy_import SET snapshot_json='{}'; VACUUM; PRAGMA journal_mode=DELETE") } finally { exported.close() }
    validateBackup(temporary)
    chmodSync(temporary, 0o600)
    // Publish exclusively: a file created while backup was running is not ours
    // to overwrite, even if the save dialog originally showed an empty path.
    linkSync(temporary, destination)
    rmSync(temporary)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  } finally {
    for (const suffix of ['-wal', '-shm']) rmSync(`${temporary}${suffix}`, { force: true })
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
  // An older backup must not restore a fact replaced by a newer correction.
  const corrected = current.prepare('SELECT memory_id, version, content, expires_at, deletion_epoch FROM memory WHERE deletion_epoch > 0 AND deleted_at IS NULL')
    .all() as { memory_id: string; version: number; content: string; expires_at: string | null; deletion_epoch: number }[]
  for (const row of corrected) {
    const old = restored.prepare('SELECT version, content, expires_at FROM memory WHERE memory_id = ?').get(row.memory_id) as typeof row | undefined
    if (old && (old.version < row.version || old.content !== row.content || old.expires_at !== row.expires_at)) all.push({ source_ref: row.memory_id, deletion_epoch: row.deletion_epoch })
  }
  const correctedTopics = current.prepare('SELECT topic_id, version, summary, deletion_epoch FROM topics WHERE deletion_epoch > 0 AND deleted_at IS NULL')
    .all() as { topic_id: string; version: number; summary: string; deletion_epoch: number }[]
  for (const row of correctedTopics) {
    const old = restored.prepare('SELECT version, summary FROM topics WHERE topic_id=?').get(row.topic_id) as { version: number; summary: string } | undefined
    if (old && (old.version < row.version || old.summary !== row.summary)) all.push({ source_ref: row.topic_id, deletion_epoch: row.deletion_epoch })
  }
  const epoch = new R1MemoryStore(current).currentDeletionEpoch()
  if (!all.length && !epoch) return

  inTransaction(restored, () => {
    const insert = restored.prepare(`INSERT INTO source_suppression (source_ref, deletion_epoch, created_at)
      VALUES (?, ?, ?) ON CONFLICT(source_ref) DO UPDATE SET
      deletion_epoch = MAX(source_suppression.deletion_epoch, excluded.deletion_epoch)`)
    const now = new Date().toISOString()
    if (epoch) invalidateMemoryContext(restored, epoch)
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
  const stagedPath = `${currentPath}.restore-${randomUUID()}.tmp`
  const rollbackPath = `${currentPath}.pre-restore-${randomUUID()}.sqlite`
  let staged: DatabaseSync | null = null
  try {
    const version = (current.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version !== R1_SCHEMA_VERSION) throw new Error('CURRENT_SCHEMA_UNSUPPORTED')
    current.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    // A valid SQLite source may have committed pages in WAL. Copying only its
    // main file would restore a different state than the preview counted.
    writeFileSync(stagedPath, '', { mode: 0o600, flag: 'wx' })
    const source = new DatabaseSync(backupPath, { readOnly: true })
    try { source.prepare('VACUUM INTO ?').run(stagedPath) } finally { source.close() }
    staged = openR1Database(stagedPath)
    // Restoring data cannot silently restore an earlier grant or revoke the user's latest choice.
    const currentPolicy = current.prepare('SELECT enabled, version FROM memory_policy WHERE id = 1').get() as { enabled: number; version: number }
    staged.prepare('UPDATE memory_policy SET enabled = ?, version = MAX(version, ?) + 1, authorized_after_rowid=(SELECT COALESCE(MAX(rowid),0) FROM messages), updated_at = ? WHERE id = 1')
      .run(currentPolicy.enabled, currentPolicy.version, new Date().toISOString())
    const preferences = current.prepare('SELECT * FROM app_preferences WHERE id=1').get()!
    staged.prepare(`UPDATE app_preferences SET input_device_id=?, output_device_id=?, do_not_disturb=?, proactive_speech=?,
      reduced_motion=?, version=MAX(version,?)+1, updated_at=? WHERE id=1`).run(preferences.input_device_id!, preferences.output_device_id!,
      preferences.do_not_disturb!, preferences.proactive_speech!, preferences.reduced_motion!, preferences.version!, new Date().toISOString())
    // Keep import markers: restoration must not silently import legacy content
    // again. Original legacy snapshots stay in the automatic rollback copy.
    const imported = current.prepare('SELECT source,imported_at FROM legacy_import').all()
    for (const row of imported) staged.prepare("INSERT OR IGNORE INTO legacy_import(source,snapshot_json,imported_at) VALUES(?,'{}',?)").run(row.source!, row.imported_at!)
    preserveSuppression(current, staged)
    staged.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    staged.close()
    staged = null
    validateBackup(stagedPath)
    current.close()
    copyFileSync(currentPath, rollbackPath)
    chmodSync(rollbackPath, 0o600)
    chmodSync(stagedPath, 0o600)
    renameSync(stagedPath, currentPath)
    return rollbackPath
  } catch (error) {
    try { staged?.close() } catch { /* preserve original error */ }
    try { current.close() } catch { /* preserve original error */ }
    rmSync(stagedPath, { force: true })
    throw error
  } finally {
    // A preflight migration can leave a snapshot of the owned staging file.
    const prefix = stagedPath.slice(stagedPath.lastIndexOf('/') + 1)
    for (const name of readdirSync(dirname(stagedPath))) if (name.startsWith(`${prefix}.pre-schema-`)) rmSync(`${dirname(stagedPath)}/${name}`, { force: true })
    for (const suffix of ['-wal', '-shm']) rmSync(`${stagedPath}${suffix}`, { force: true })
  }
}
