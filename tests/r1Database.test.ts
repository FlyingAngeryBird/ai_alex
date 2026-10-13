import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
