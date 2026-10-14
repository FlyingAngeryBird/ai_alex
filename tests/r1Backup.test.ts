import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createR1Backup, restoreR1BackupOffline } from '../electron/main/r1/backup'
import { openR1Database, R1_SCHEMA_VERSION } from '../electron/main/r1/database'
import { R1MemoryStore } from '../electron/main/r1/memory'
import { R1Conversations } from '../electron/main/r1/conversations'

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

  it('never restores a corrected fact or derived model history from an older backup, while preserving raw history', async () => {
    const root = directory(), currentPath = join(root, 'r1.sqlite'), backupPath = join(root, 'before-correction.sqlite')
    const db = openR1Database(currentPath), conversations = new R1Conversations(db), memory = new R1MemoryStore(db)
    const sessionId = conversations.start()
    const source = conversations.append({ sessionId, turnId: 'old', role: 'user', body: '记住，我喜欢红茶。', status: 'final' })
    const old = memory.remember({ content: '喜欢红茶', category: 'preference', sourceMessageIds: [source.messageId] })
    const unrelated = memory.remember({ content: '喜欢公园', category: 'preference', sourceMessageIds: [source.messageId] })
    conversations.append({ sessionId, turnId: 'derived', role: 'assistant', body: '可以选红茶。', status: 'generated' })
    await createR1Backup(db, backupPath)
    const correction = conversations.append({ sessionId, turnId: 'new', role: 'user', body: '更正记忆，我喜欢绿茶。', status: 'final' })
    memory.update({ memoryId: old.memoryId, expectedVersion: 1, content: '喜欢绿茶', category: 'preference', sourceMessageIds: [correction.messageId] })
    db.close()
    restoreR1BackupOffline(currentPath, backupPath)
    const restored = openR1Database(currentPath)
    try {
      const store = new R1MemoryStore(restored), history = new R1Conversations(restored)
      expect(store.currentDeletionEpoch()).toBe(1)
      expect(store.recall('红茶')).toEqual([])
      expect(store.recall('公园')).toEqual([unrelated])
      expect(history.messages(sessionId)).toHaveLength(2)
      expect(history.modelTurns(sessionId)).toEqual([])
      expect(() => store.remember({ content: '喜欢红茶', category: 'preference', sourceMessageIds: [source.messageId] })).toThrow('MEMORY_SOURCE_SUPPRESSED')
      history.append({ sessionId, turnId: 'after-restore', role: 'user', body: '今天聊公园。', status: 'final' })
      expect(history.modelTurns(sessionId)).toMatchObject([{ text: '今天聊公园。' }])
    } finally { restored.close() }
  })
})
