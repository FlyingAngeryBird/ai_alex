import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const R1_SCHEMA_VERSION = 11

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

let savepointSequence = 0
type TransactionEffects = { commit: Array<() => void>; rollback: Array<() => void> }
const transactionEffects = new WeakMap<R1Database, TransactionEffects[]>()
export function afterTransactionCommit(db: R1Database, effect: () => void): void {
  const frame = transactionEffects.get(db)?.at(-1)
  if (frame) frame.commit.push(effect)
  else if (!db.isTransaction) effect()
  else throw new Error('TRANSACTION_EFFECT_SCOPE_UNKNOWN')
}
export function afterTransactionRollback(db: R1Database, effect: () => void): void {
  const frame = transactionEffects.get(db)?.at(-1)
  if (frame) frame.rollback.push(effect)
  else if (db.isTransaction) throw new Error('TRANSACTION_EFFECT_SCOPE_UNKNOWN')
}
export function inTransaction<T>(db: R1Database, action: () => T): T {
  if (db.isTransaction && !transactionEffects.get(db)?.length) throw new Error('TRANSACTION_EFFECT_SCOPE_UNKNOWN')
  const savepoint = db.isTransaction ? `r1_transaction_${++savepointSequence}` : null
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
  const stack = transactionEffects.get(db) ?? []
  transactionEffects.set(db, stack)
  const effects: TransactionEffects = { commit: [], rollback: [] }
  stack.push(effects)
  let result: T
  try {
    result = action()
    db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT')
  } catch (error) {
    try {
      if (savepoint) { db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); db.exec(`RELEASE SAVEPOINT ${savepoint}`) }
      else db.exec('ROLLBACK')
    } finally {
      stack.pop()
      for (const effect of effects.rollback.reverse()) { try { effect() } catch { /* Preserve original transaction error. */ } }
    }
    throw error
  }
  stack.pop()
  if (stack.length) { stack.at(-1)!.commit.push(...effects.commit); stack.at(-1)!.rollback.push(...effects.rollback) }
  else for (const effect of effects.commit) { try { effect() } catch { /* Data is committed; notification failure cannot undo it. */ } }
  return result
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
  if (row.user_version > 0 && row.user_version < R1_SCHEMA_VERSION && databasePath !== ':memory:') {
    const snapshot = `${databasePath}.pre-schema-${row.user_version}-to-${R1_SCHEMA_VERSION}-${randomUUID()}.sqlite`
    try {
      db.prepare('VACUUM INTO ?').run(snapshot)
      chmodSync(snapshot, 0o600)
      const copy = new DatabaseSync(snapshot, { readOnly: true })
      try {
        if ((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok' ||
          (copy.prepare('PRAGMA user_version').get() as { user_version: number }).user_version !== row.user_version) {
          throw new Error('MIGRATION_SNAPSHOT_INVALID')
        }
      } finally { copy.close() }
    } catch (error) { db.close(); throw error }
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
  if (migratedVersion < 4) {
    inTransaction(db, () => {
      const columns = new Set((db.prepare('PRAGMA table_info(artifact_versions)').all() as { name: string }[]).map(row => row.name))
      if (!columns.has('metadata_json')) db.exec("ALTER TABLE artifact_versions ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'")
      db.exec('PRAGMA user_version = 4')
    })
  }
  if (migratedVersion < 5) {
    inTransaction(db, () => {
      const columns = new Set((db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[]).map(row => row.name))
      if (!columns.has('saved_item_version')) db.exec('ALTER TABLE artifacts ADD COLUMN saved_item_version INTEGER')
      db.exec('PRAGMA user_version = 5')
    })
  }
  if (migratedVersion < 6) {
    inTransaction(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS memory_policy (
        id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        version INTEGER NOT NULL, updated_at TEXT NOT NULL)`)
      db.prepare('INSERT OR IGNORE INTO memory_policy (id, enabled, version, updated_at) VALUES (1, 0, 1, ?)').run(new Date().toISOString())
      const columns = new Set((db.prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map(row => row.name))
      if (!columns.has('authorization_version')) db.exec('ALTER TABLE memory ADD COLUMN authorization_version INTEGER')
      db.exec('PRAGMA user_version = 6')
    })
  }
  if (migratedVersion < 7) {
    inTransaction(db, () => {
      const policyColumns = new Set((db.prepare('PRAGMA table_info(memory_policy)').all() as { name: string }[]).map(row => row.name))
      if (!policyColumns.has('authorized_after_rowid')) {
        db.exec('ALTER TABLE memory_policy ADD COLUMN authorized_after_rowid INTEGER NOT NULL DEFAULT 0')
        db.exec('UPDATE memory_policy SET authorized_after_rowid=(SELECT COALESCE(MAX(rowid),0) FROM messages)')
      }
      db.exec(`CREATE TABLE IF NOT EXISTS topic_versions (topic_id TEXT NOT NULL REFERENCES topics(topic_id), version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL, origin TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(topic_id, version))`)
      db.exec(`INSERT OR IGNORE INTO topic_versions SELECT topic_id, version,
        json_object('topicId', topic_id, 'title', title, 'summary', summary, 'unresolved', json(unresolved_json),
          'sourceRefs', json(source_refs_json), 'status', status, 'version', version, 'deletionEpoch', deletion_epoch, 'updatedAt', updated_at),
        'legacy', updated_at FROM topics WHERE deleted_at IS NULL`)
      db.exec('PRAGMA user_version = 7')
    })
  }
  if (migratedVersion < 8) {
    inTransaction(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS music_settings (id INTEGER PRIMARY KEY CHECK(id=1),
        base_volume REAL NOT NULL DEFAULT 100, queue_version INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS music_search_history (query TEXT PRIMARY KEY, searched_at TEXT NOT NULL)`)
      db.prepare('INSERT OR IGNORE INTO music_settings(id, updated_at) VALUES (1, ?)').run(new Date().toISOString())
      const columns = new Set((db.prepare('PRAGMA table_info(music_feedback)').all() as { name: string }[]).map(row => row.name))
      if (!columns.has('scene')) db.exec('ALTER TABLE music_feedback ADD COLUMN scene TEXT')
      if (!columns.has('source_ref')) db.exec('ALTER TABLE music_feedback ADD COLUMN source_ref TEXT')
      db.exec('UPDATE music_settings SET queue_version=(SELECT COALESCE(MAX(queue_version),0) FROM music_queue)')
      db.exec('PRAGMA user_version = 8')
    })
  }
  if (migratedVersion < 9) {
    inTransaction(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS app_preferences (id INTEGER PRIMARY KEY CHECK(id=1),
        input_device_id TEXT, output_device_id TEXT, do_not_disturb INTEGER NOT NULL DEFAULT 0 CHECK(do_not_disturb IN (0,1)),
        proactive_speech INTEGER NOT NULL DEFAULT 1 CHECK(proactive_speech IN (0,1)), version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL)`)
      db.prepare('INSERT OR IGNORE INTO app_preferences(id,updated_at) VALUES(1,?)').run(new Date().toISOString())
      db.exec('PRAGMA user_version=9')
    })
  }
  if (migratedVersion < 10) {
    inTransaction(db, () => {
      const columns = new Set((db.prepare('PRAGMA table_info(app_preferences)').all() as { name: string }[]).map(row => row.name))
      if (!columns.has('reduced_motion')) db.exec('ALTER TABLE app_preferences ADD COLUMN reduced_motion INTEGER NOT NULL DEFAULT 0 CHECK(reduced_motion IN (0,1))')
      db.exec('PRAGMA user_version=10')
    })
  }
  if (migratedVersion < 11) {
    inTransaction(db, () => {
      // A cleared history must not reuse rowids below a deletion/context cutoff.
      db.exec(`CREATE TABLE messages_v11 (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions(session_id), turn_id TEXT NOT NULL, response_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), body TEXT NOT NULL,
        status TEXT NOT NULL, played_until_ms INTEGER, created_at TEXT NOT NULL);
        INSERT INTO messages_v11(sequence,message_id,session_id,turn_id,response_id,role,body,status,played_until_ms,created_at)
          SELECT rowid,message_id,session_id,turn_id,response_id,role,body,status,played_until_ms,created_at FROM messages ORDER BY rowid;
        DROP TABLE messages; ALTER TABLE messages_v11 RENAME TO messages;
        CREATE INDEX messages_session_time ON messages(session_id,created_at);
        PRAGMA user_version=11`)
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
