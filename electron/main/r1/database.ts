import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const R1_SCHEMA_VERSION = 3

export type R1Database = DatabaseSync

type LegacyImportResult = {
  imported: boolean
  favorites: number
  voiceId: string | null
}

const SCHEMA_V2 = `
  CREATE TABLE IF NOT EXISTS persona (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    assistant_name TEXT NOT NULL,
    user_address TEXT NOT NULL DEFAULT '',
    style TEXT NOT NULL DEFAULT 'balanced',
    voice_id TEXT NOT NULL DEFAULT '',
    prompt_override TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    temporary INTEGER NOT NULL CHECK (temporary IN (0, 1)),
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id),
    turn_id TEXT NOT NULL,
    response_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    played_until_ms INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_session_time ON messages(session_id, created_at);
  CREATE TABLE IF NOT EXISTS memory (
    memory_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    category TEXT NOT NULL,
    source_refs_json TEXT NOT NULL,
    authorization TEXT NOT NULL,
    occurred_at TEXT,
    expires_at TEXT,
    version INTEGER NOT NULL,
    deletion_epoch INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_active ON memory(deleted_at, expires_at);
  CREATE TABLE IF NOT EXISTS topics (
    topic_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    unresolved_json TEXT NOT NULL,
    source_refs_json TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    deletion_epoch INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS source_suppression (
    source_ref TEXT PRIMARY KEY,
    deletion_epoch INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    item_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('note', 'todo')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    source_ref TEXT,
    version INTEGER NOT NULL,
    completed_at TEXT,
    completion_action_id TEXT,
    deleted_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS items_active ON items(deleted_at, kind, completed_at);
  CREATE TABLE IF NOT EXISTS reminders (
    reminder_id TEXT PRIMARY KEY,
    item_id TEXT REFERENCES items(item_id) ON DELETE SET NULL,
    link_purpose TEXT NOT NULL CHECK (link_purpose IN ('todo_due', 'independent', 'other')),
    kind TEXT NOT NULL CHECK (kind IN ('standard', 'followup')),
    body TEXT NOT NULL,
    due_at_utc TEXT NOT NULL,
    timezone TEXT NOT NULL,
    schedule_version INTEGER NOT NULL,
    previous_schedule_version INTEGER,
    status TEXT NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'pending',
    cancel_reason TEXT,
    cancel_action_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reminders_due ON reminders(status, due_at_utc);
  CREATE TABLE IF NOT EXISTS focus (
    focus_id TEXT PRIMARY KEY,
    duration_sec INTEGER NOT NULL,
    remaining_sec INTEGER NOT NULL,
    state TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS music_favorites (
    track_key TEXT PRIMARY KEY,
    track_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS music_feedback (
    feedback_id TEXT PRIMARY KEY,
    track_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS music_queue (
    entry_id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    track_key TEXT NOT NULL,
    track_json TEXT NOT NULL,
    queue_version INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    source_turn_id TEXT NOT NULL,
    current_version INTEGER NOT NULL,
    saved_item_id TEXT REFERENCES items(item_id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS artifact_versions (
    artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
    version INTEGER NOT NULL,
    base_version INTEGER,
    body TEXT NOT NULL,
    target_ref TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, version)
  );
  CREATE TABLE IF NOT EXISTS agent_tasks (
    task_id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(session_id),
    goal TEXT NOT NULL,
    constraints_json TEXT NOT NULL,
    goal_version INTEGER NOT NULL,
    asset_release_id TEXT NOT NULL,
    status TEXT NOT NULL,
    budget_json TEXT NOT NULL,
    checkpoint_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task_runs (
    run_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES agent_tasks(task_id),
    goal_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE TABLE IF NOT EXISTS receipts (
    action_id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES agent_tasks(task_id),
    run_id TEXT REFERENCES task_runs(run_id),
    entity_id TEXT,
    entity_version INTEGER,
    status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled', 'unknown')),
    actual_result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    delivery_id TEXT PRIMARY KEY,
    reminder_id TEXT NOT NULL REFERENCES reminders(reminder_id),
    schedule_version INTEGER NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (reminder_id, schedule_version)
  );
  CREATE TABLE IF NOT EXISTS event_log (
    event_id TEXT PRIMARY KEY,
    occurred_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    owner_id TEXT,
    payload_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS legacy_import (
    source TEXT PRIMARY KEY,
    snapshot_json TEXT NOT NULL,
    imported_at TEXT NOT NULL
  );
`

export function inTransaction<T>(db: R1Database, action: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function openR1Database(databasePath: string): R1Database {
  if (databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true })
  }

  const db = new DatabaseSync(databasePath)
  db.exec('PRAGMA foreign_keys = ON')
  if (databasePath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL')
  }

  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (row.user_version > R1_SCHEMA_VERSION) {
    db.close()
    throw new Error(`R1 database schema ${row.user_version} is newer than supported ${R1_SCHEMA_VERSION}`)
  }
  if (row.user_version < 1) {
    inTransaction(db, () => {
      db.exec(SCHEMA_V2)
      db.prepare(`INSERT INTO persona (id, assistant_name, updated_at) VALUES (1, 'Seamo AI', ?)`)
        .run(new Date().toISOString())
      db.exec('PRAGMA user_version = 2')
    })
  } else if (row.user_version === 1) {
    inTransaction(db, () => {
      db.exec(`CREATE TABLE deliveries_v2 (
        delivery_id TEXT PRIMARY KEY,
        reminder_id TEXT NOT NULL REFERENCES reminders(reminder_id),
        schedule_version INTEGER NOT NULL,
        channel TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (reminder_id, schedule_version)
      )`)
      db.exec(`INSERT OR IGNORE INTO deliveries_v2
        (delivery_id, reminder_id, schedule_version, channel, status, created_at)
        SELECT delivery_id, reminder_id, schedule_version, channel, status, created_at
        FROM deliveries ORDER BY CASE WHEN channel = 'system' THEN 0 ELSE 1 END, created_at`)
      db.exec('DROP TABLE deliveries')
      db.exec('ALTER TABLE deliveries_v2 RENAME TO deliveries')
      db.exec('PRAGMA user_version = 2')
    })
  }
  const migratedVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (migratedVersion < 3) {
    inTransaction(db, () => {
      const columns = new Set((db.prepare('PRAGMA table_info(focus)').all() as { name: string }[]).map(row => row.name))
      if (!columns.has('end_music_rule')) db.exec("ALTER TABLE focus ADD COLUMN end_music_rule TEXT NOT NULL DEFAULT 'none'")
      if (!columns.has('end_target_track_key')) db.exec('ALTER TABLE focus ADD COLUMN end_target_track_key TEXT')
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS focus_one_active ON focus((1)) WHERE state IN (\'running\', \'paused\')')
      db.exec('PRAGMA user_version = 3')
    })
  }
  return db
}

export function importLegacyJson(db: R1Database, legacyUserDataPath: string,
  source = 'lingmo-json'): LegacyImportResult {
  const readOptionalJson = (name: string): unknown | null => {
    try {
      return JSON.parse(readFileSync(join(legacyUserDataPath, name), 'utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const config = readOptionalJson('config.json')
  const music = readOptionalJson('music.json')
  const hasImported = db.prepare('SELECT 1 AS found FROM legacy_import WHERE source = ?').get(source)
  if (hasImported || (config === null && music === null)) {
    return { imported: false, favorites: 0, voiceId: null }
  }

  const voice = (config as { voice?: { activeVoiceId?: unknown; voiceId?: unknown } } | null)?.voice
  const voiceId = typeof voice?.activeVoiceId === 'string'
    ? voice.activeVoiceId
    : typeof voice?.voiceId === 'string' ? voice.voiceId : null
  const tracks = (music as { favorites?: unknown } | null)?.favorites
  const favorites = Array.isArray(tracks) ? tracks.filter((track): track is Record<string, unknown> =>
    track !== null && typeof track === 'object' &&
    typeof track.id === 'string' && typeof track.title === 'string' && typeof track.artist === 'string'
  ) : []
  const now = new Date().toISOString()

  inTransaction(db, () => {
    if (voiceId) {
      db.prepare('UPDATE persona SET voice_id = ?, version = version + 1, updated_at = ? WHERE id = 1')
        .run(voiceId, now)
    }
    const insertFavorite = db.prepare(
      'INSERT OR IGNORE INTO music_favorites (track_key, track_json, created_at) VALUES (?, ?, ?)'
    )
    for (const track of favorites) {
      const key = `${typeof track.source === 'string' ? track.source : 'unknown'}:${track.id}`
      insertFavorite.run(key, JSON.stringify(track), now)
    }
    db.prepare('INSERT INTO legacy_import (source, snapshot_json, imported_at) VALUES (?, ?, ?)')
      .run(source, JSON.stringify({ config, music }), now)
  })
  return { imported: true, favorites: favorites.length, voiceId }
}
