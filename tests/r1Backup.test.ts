import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createR1Backup, restoreR1BackupOffline } from '../electron/main/r1/backup'
import { openR1Database, R1_SCHEMA_VERSION } from '../electron/main/r1/database'

const directories: string[] = []
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'seamo-backup-'))
  directories.push(path)
  return path
}
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('R1 offline backup and restore', () => {
  it('migrates an older v2 backup in a staging copy and preserves the source backup', async () => {
    const root = directory()
    const currentPath = join(root, 'r1.sqlite')
    const backupPath = join(root, 'v2.sqlite')
    const db = openR1Database(currentPath)
    await createR1Backup(db, backupPath)
    db.close()
    const old = new DatabaseSync(backupPath)
    old.exec('DROP INDEX focus_one_active')
    old.exec('ALTER TABLE focus DROP COLUMN end_music_rule')
    old.exec('ALTER TABLE focus DROP COLUMN end_target_track_key')
    old.exec('PRAGMA user_version = 2')
    old.close()
    const sourceBytes = readFileSync(backupPath)
    restoreR1BackupOffline(currentPath, backupPath)
    expect(readFileSync(backupPath)).toEqual(sourceBytes)
    const restored = openR1Database(currentPath)
    expect(restored.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: R1_SCHEMA_VERSION })
    restored.close()
  })
  it('preserves deletion suppression so an old backup cannot revive forgotten memory', async () => {
    const root = directory()
    const currentPath = join(root, 'r1.sqlite')
    const backupPath = join(root, 'backup.sqlite')
    const db = openR1Database(currentPath)
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO memory
      (memory_id, content, category, source_refs_json, authorization, version, created_at, updated_at)
      VALUES ('memory-1', 'old private fact', 'preference', '["source-1"]', 'explicit', 1, ?, ?)`)
      .run(now, now)
    await createR1Backup(db, backupPath)
    expect(statSync(backupPath).mode & 0o777).toBe(0o600)
    db.prepare('UPDATE memory SET deleted_at = ?, deletion_epoch = 3 WHERE memory_id = ?')
      .run(now, 'memory-1')
    db.prepare('INSERT INTO source_suppression VALUES (?, 3, ?)').run('source-1', now)
    db.close()

    const rollback = restoreR1BackupOffline(currentPath, backupPath)
    const restored = new DatabaseSync(currentPath, { readOnly: true })
    expect(restored.prepare('SELECT deleted_at, deletion_epoch FROM memory WHERE memory_id = ?')
      .get('memory-1')).toMatchObject({ deleted_at: expect.any(String), deletion_epoch: 3 })
    expect(restored.prepare('SELECT deletion_epoch FROM source_suppression WHERE source_ref = ?')
      .get('source-1')).toMatchObject({ deletion_epoch: 3 })
    restored.close()
    const old = new DatabaseSync(rollback, { readOnly: true })
    expect(old.prepare('SELECT deletion_epoch FROM memory WHERE memory_id = ?').get('memory-1'))
      .toMatchObject({ deletion_epoch: 3 })
    old.close()
  })

  it('rejects an invalid backup without changing the current database', () => {
    const root = directory()
    const currentPath = join(root, 'r1.sqlite')
    const invalidPath = join(root, 'bad.sqlite')
    const db = openR1Database(currentPath)
    db.close()
    const marker = 'not a database'
    writeFileSync(invalidPath, marker)
    expect(() => restoreR1BackupOffline(currentPath, invalidPath)).toThrow()
    const stillGood = new DatabaseSync(currentPath, { readOnly: true })
    expect(stillGood.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: R1_SCHEMA_VERSION })
    stillGood.close()
  })
})
