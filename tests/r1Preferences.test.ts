import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { openR1Database, inTransaction, R1_SCHEMA_VERSION } from '../electron/main/r1/database'
import { R1Preferences } from '../electron/main/r1/preferences'
import { registerPreferencesHandlers } from '../electron/main/ipc/preferencesHandlers'
import { createPreferencesController } from '../src/composables/useAppPreferences'
it('persists versioned device and quiet preferences while keeping rollback and stale updates safe', () => {
  const db = openR1Database(':memory:'), preferences = new R1Preferences(db), changed = vi.fn()
  preferences.onChanged(changed)
  try {
    expect(preferences.get()).toEqual({ inputDeviceId: null, outputDeviceId: null, doNotDisturb: false, proactiveSpeechEnabled: true, reducedMotion: false, version: 1 })
    expect(() => inTransaction(db, () => { preferences.update({ expectedVersion: 1, doNotDisturb: true }); throw new Error('rollback') })).toThrow('rollback')
    expect(changed).not.toHaveBeenCalled(); expect(preferences.get().version).toBe(1)
    preferences.update({ expectedVersion: 1, doNotDisturb: true, inputDeviceId: 'selected-mic', outputDeviceId: 'headphones', proactiveSpeechEnabled: false })
    expect(new R1Preferences(db).get()).toMatchObject({ version: 2, doNotDisturb: true, proactiveSpeechEnabled: false, inputDeviceId: 'selected-mic' })
    expect(() => preferences.update({ expectedVersion: 1, outputDeviceId: null })).toThrow('VERSION_CONFLICT')
    expect(() => preferences.update({ expectedVersion: 2, inputDeviceId: '' })).toThrow('INVALID_AUDIO_DEVICE_ID')
    expect(() => preferences.update({ expectedVersion: 2, doNotDisturb: 'yes' } as never)).toThrow('INVALID_PREFERENCES_PATCH')
    expect(changed).toHaveBeenCalledTimes(1)
  } finally { db.close() }
})
it('migrates schema8 without altering music and leaves a verified schema8 rollback database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'seamo-preferences-')), path = join(directory, 'r1.sqlite'), db = openR1Database(path)
  db.exec('UPDATE music_settings SET base_volume=30,queue_version=7; DROP TABLE app_preferences; PRAGMA user_version=8'); db.close()
  const upgraded = openR1Database(path)
  try {
    expect(upgraded.prepare('SELECT base_volume,queue_version FROM music_settings').get()).toMatchObject({ base_volume: 30, queue_version: 7 })
    expect(new R1Preferences(upgraded).get().version).toBe(1)
    const previous = new DatabaseSync(join(directory, readdirSync(directory).find(name => name.includes(`.pre-schema-8-to-${R1_SCHEMA_VERSION}-`))!), { readOnly: true })
    try { expect(previous.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 8 }); expect(previous.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' }) }
    finally { previous.close() }
  } finally { upgraded.close(); rmSync(directory, { recursive: true, force: true }) }
})
it('uses actual preference IPC/CAS and ignores a late older read in the shared frontend state', async () => {
  const db = openR1Database(':memory:'), preferences = new R1Preferences(db)
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>(), subscribers = new Set<(value: ReturnType<R1Preferences['get']>) => void>()
  registerPreferencesHandlers(preferences, { handle(channel, handler) { handlers.set(channel, handler) } }, value => subscribers.forEach(listener => listener(value)))
  const api = { get: vi.fn(async () => handlers.get('r1.preferences.get')!(null) as { ok: true; data: ReturnType<R1Preferences['get']> }),
    update: async (input: Parameters<R1Preferences['update']>[0]) => handlers.get('r1.preferences.update')!(null, input) as { ok: true; data: ReturnType<R1Preferences['get']> },
    onChanged(listener: (value: ReturnType<R1Preferences['get']>) => void) { subscribers.add(listener); return () => subscribers.delete(listener) } }
  const frontend = createPreferencesController(() => api)
  try {
    await frontend.load(); const old = frontend.value.value!
    expect(await frontend.update({ doNotDisturb: true })).toBe(true)
    api.get.mockResolvedValueOnce({ ok: true, data: old }); await frontend.load()
    expect(frontend.value.value).toMatchObject({ version: 2, doNotDisturb: true })
    expect(handlers.get('r1.preferences.update')!(null, { expectedVersion: 1, doNotDisturb: false })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } })
  } finally { frontend.dispose(); db.close() }
})
it('upgrades schema9 while preserving saved device/quiet choices and a usable rollback snapshot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'seamo-motion-')), path = join(directory, 'r1.sqlite'), db = openR1Database(path)
  new R1Preferences(db).update({ expectedVersion: 1, inputDeviceId: 'selected-mic', doNotDisturb: true })
  db.exec('ALTER TABLE app_preferences DROP COLUMN reduced_motion; PRAGMA user_version=9'); db.close()
  const upgraded = openR1Database(path)
  try {
    const preferences = new R1Preferences(upgraded)
    expect(preferences.get()).toMatchObject({ version: 2, inputDeviceId: 'selected-mic', doNotDisturb: true, reducedMotion: false })
    preferences.update({ expectedVersion: 2, reducedMotion: true })
    expect(new R1Preferences(upgraded).get()).toMatchObject({ version: 3, reducedMotion: true })
    expect(() => preferences.update({ expectedVersion: 3, reducedMotion: 'true' } as never)).toThrow('INVALID_PREFERENCES_PATCH')
    const snapshot = new DatabaseSync(join(directory, readdirSync(directory).find(name => name.includes(`.pre-schema-9-to-${R1_SCHEMA_VERSION}-`))!), { readOnly: true })
    try { expect(snapshot.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 9 }); expect(snapshot.prepare('SELECT do_not_disturb,version FROM app_preferences').get()).toMatchObject({ do_not_disturb: 1, version: 2 }) }
    finally { snapshot.close() }
  } finally { upgraded.close(); rmSync(directory, { recursive: true, force: true }) }
})
