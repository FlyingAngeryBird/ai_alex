import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importLegacyJson, openR1Database, R1_SCHEMA_VERSION } from '../electron/main/r1/database'
import { R1Items } from '../electron/main/r1/items'

const temporaryDirectories: string[] = []

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seamo-r1-db-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('R1 database and legacy import', () => {
  it('upgrades v7 music without losing saved identities and retains a readable v7 rollback snapshot', () => {
    const directory = makeDirectory(), path = join(directory, 'v7.sqlite'), db = openR1Database(path)
    db.prepare('INSERT INTO music_favorites VALUES (?,?,?)').run('netease:old', JSON.stringify({ source: 'netease', id: 'old', title: '原收藏', artist: '原歌手', durationMs: 0 }), '2026-10-14')
    db.prepare('INSERT INTO music_queue VALUES (?,?,?,?,?)').run('entry-old', 0, 'netease:old', '{}', 9)
    db.prepare('INSERT INTO music_feedback(feedback_id,track_key,kind,created_at) VALUES (?,?,?,?)').run('feedback-old', 'netease:old', 'skip', '2026-10-14')
    db.exec('DROP TABLE music_settings; DROP TABLE music_search_history; ALTER TABLE music_feedback DROP COLUMN scene; ALTER TABLE music_feedback DROP COLUMN source_ref; PRAGMA user_version=7'); db.close()
    const migrated = openR1Database(path)
    try {
      expect(migrated.prepare('SELECT base_volume,queue_version FROM music_settings').get()).toMatchObject({ base_volume: 100, queue_version: 9 })
      expect(migrated.prepare('SELECT entry_id FROM music_queue').all()).toEqual([{ entry_id: 'entry-old' }])
      expect(migrated.prepare('SELECT kind,scene,source_ref FROM music_feedback').get()).toMatchObject({ kind: 'skip', scene: null, source_ref: null })
      const snapshot = readdirSync(directory).find(name => name.includes('.pre-schema-7-to-8-'))!
      const previous = new DatabaseSync(join(directory, snapshot), { readOnly: true })
      try {
        expect(previous.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 7 })
        expect(previous.prepare('SELECT track_key FROM music_favorites').get()).toMatchObject({ track_key: 'netease:old' })
        expect(previous.prepare('SELECT entry_id FROM music_queue').get()).toMatchObject({ entry_id: 'entry-old' })
        expect(previous.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' })
      } finally { previous.close() }
    } finally { migrated.close() }
  })
  it('migrates a v6 Topic as its actual baseline version and blocks pre-upgrade summary backfill', () => {
    const path = join(makeDirectory(), 'v6.sqlite'), db = openR1Database(path), now = new Date().toISOString()
    db.prepare(`INSERT INTO topics (topic_id,title,summary,unresolved_json,source_refs_json,status,version,updated_at)
      VALUES ('old-topic','旧话题','已确认的阶段结论','[]','[]','active',3,?)`).run(now)
    db.prepare("INSERT INTO sessions VALUES ('session',0,'active',?,NULL)").run(now)
    db.prepare("INSERT INTO messages (message_id,session_id,turn_id,role,body,status,created_at) VALUES ('source','session','turn','user','旧来源','final',?)").run(now)
    db.exec('DROP TABLE topic_versions; ALTER TABLE memory_policy DROP COLUMN authorized_after_rowid; PRAGMA user_version=6'); db.close()
    const migrated = openR1Database(path)
    try {
      expect(migrated.prepare('SELECT version,origin FROM topic_versions').get()).toMatchObject({ version: 3, origin: 'legacy' })
      expect(migrated.prepare('SELECT authorized_after_rowid FROM memory_policy').get()).toMatchObject({ authorized_after_rowid: 1 })
    } finally { migrated.close() }
  })
  it('migrates a v5 database with automatic memory off and preserves explicit memory and sources', () => {
    const path = join(makeDirectory(), 'v5.sqlite'), db = openR1Database(path)
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO memory (memory_id, content, category, source_refs_json, authorization, version, created_at, updated_at)
      VALUES ('old', '喜欢公园', 'preference', '[]', 'explicit', 1, ?, ?)`).run(now, now)
    db.exec('DROP TABLE memory_policy; ALTER TABLE memory DROP COLUMN authorization_version; PRAGMA user_version = 5'); db.close()
    const migrated = openR1Database(path)
    try {
      expect(migrated.prepare('SELECT enabled, version FROM memory_policy').get()).toMatchObject({ enabled: 0, version: 1 })
      expect(migrated.prepare('SELECT content, authorization, authorization_version FROM memory WHERE memory_id = ?').get('old'))
        .toMatchObject({ content: '喜欢公园', authorization: 'explicit', authorization_version: null })
    } finally { migrated.close() }
  })
  it('upgrades the existing v2 focus row without losing its countdown or creating a second active timer', () => {
    const path = join(makeDirectory(), 'r1.sqlite')
    const db = openR1Database(path)
    db.exec('DROP TABLE focus')
    db.exec(`CREATE TABLE focus (focus_id TEXT PRIMARY KEY, duration_sec INTEGER NOT NULL,
      remaining_sec INTEGER NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL)`)
    db.prepare('INSERT INTO focus VALUES (?, ?, ?, ?, ?, ?)').run('old-focus', 1500, 900, 'paused', 2, new Date().toISOString())
    db.exec('PRAGMA user_version = 2')
    db.close()
    const migrated = openR1Database(path)
    expect(migrated.prepare('SELECT * FROM focus').get()).toMatchObject({ focus_id: 'old-focus',
      remaining_sec: 900, state: 'paused', version: 2, end_music_rule: 'none', end_target_track_key: null })
    expect(() => migrated.prepare(`INSERT INTO focus
      (focus_id, duration_sec, remaining_sec, state, version, updated_at) VALUES ('second', 60, 60, 'running', 1, ?)`)
      .run(new Date().toISOString())).toThrow()
    migrated.close()
  })
  it('creates the versioned domain schema and opens it again without changing data', () => {
    const path = join(makeDirectory(), 'r1.sqlite')
    const db = openR1Database(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(R1_SCHEMA_VERSION)
    expect(db.prepare('SELECT assistant_name FROM persona WHERE id = 1').get())
      .toMatchObject({ assistant_name: 'Seamo AI' })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'receipts'").get())
      .toMatchObject({ name: 'receipts' })
    db.close()

    const reopened = openR1Database(path)
    expect(reopened.prepare('SELECT COUNT(*) AS count FROM persona').get()).toMatchObject({ count: 1 })
    reopened.close()
  })

  it('rejects a future schema instead of silently rewriting it', () => {
    const path = join(makeDirectory(), 'r1.sqlite')
    const db = openR1Database(path)
    db.exec('PRAGMA user_version = 99')
    db.close()
    expect(() => openR1Database(path)).toThrow('newer than supported')
  })

  it('migrates a v1 delivery table without reviving duplicate schedule deliveries', () => {
    const path = join(makeDirectory(), 'r1.sqlite')
    const db = openR1Database(path)
    const reminder = new R1Items(db).createReminder({ actionId: 'create',
      linkPurpose: 'independent', body: '提醒', dueAtUtc: new Date(Date.now() + 60_000).toISOString(),
      timezone: 'Asia/Shanghai' }).reminder
    db.exec('DROP TABLE deliveries')
    db.exec(`CREATE TABLE deliveries (
      delivery_id TEXT PRIMARY KEY, reminder_id TEXT NOT NULL REFERENCES reminders(reminder_id),
      schedule_version INTEGER NOT NULL, channel TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE (reminder_id, schedule_version, channel))`)
    db.prepare('INSERT INTO deliveries VALUES (?, ?, 1, ?, ?, ?)')
      .run('in-app', reminder.reminderId, 'in_app', 'requested', new Date().toISOString())
    db.prepare('INSERT INTO deliveries VALUES (?, ?, 1, ?, ?, ?)')
      .run('system', reminder.reminderId, 'system', 'requested', new Date().toISOString())
    db.exec('PRAGMA user_version = 1')
    db.close()

    const migrated = openR1Database(path)
    expect(migrated.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: R1_SCHEMA_VERSION })
    expect(migrated.prepare('SELECT channel FROM deliveries').all()).toEqual([{ channel: 'system' }])
    expect(() => migrated.prepare('INSERT INTO deliveries VALUES (?, ?, 1, ?, ?, ?)')
      .run('duplicate', reminder.reminderId, 'in_app', 'requested', new Date().toISOString())).toThrow()
    migrated.close()
  })

  it('imports old JSON once, preserves the old files, and does not import the old assistant name', () => {
    const directory = makeDirectory()
    const legacy = join(directory, 'legacy')
    mkdirSync(legacy)
    const configPath = join(legacy, 'config.json')
    const musicPath = join(legacy, 'music.json')
    const config = JSON.stringify({ persona: { systemPrompt: '你是 lingmo' }, voice: { activeVoiceId: 'voice-a' } })
    const music = JSON.stringify({ favorites: [{ id: '1', source: 'netease', title: '晴天', artist: '周杰伦' }] })
    writeFileSync(configPath, config)
    writeFileSync(musicPath, music)
    const db = openR1Database(join(directory, 'new', 'r1.sqlite'))

    expect(importLegacyJson(db, legacy)).toEqual({ imported: true, favorites: 1, voiceId: 'voice-a' })
    expect(importLegacyJson(db, legacy)).toEqual({ imported: false, favorites: 0, voiceId: null })
    expect(db.prepare('SELECT COUNT(*) AS count FROM music_favorites').get()).toMatchObject({ count: 1 })
    expect(db.prepare('SELECT assistant_name, voice_id FROM persona WHERE id = 1').get())
      .toMatchObject({ assistant_name: 'Seamo AI', voice_id: 'voice-a' })
    expect(readFileSync(configPath, 'utf8')).toBe(config)
    expect(readFileSync(musicPath, 'utf8')).toBe(music)
    db.close()
  })

  it('does not partially import when legacy JSON is invalid', () => {
    const directory = makeDirectory()
    mkdirSync(join(directory, 'legacy'))
    writeFileSync(join(directory, 'legacy', 'config.json'), '{')
    const db = openR1Database(join(directory, 'r1.sqlite'))
    expect(() => importLegacyJson(db, join(directory, 'legacy'))).toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM legacy_import').get()).toMatchObject({ count: 0 })
    db.close()
  })
})
