import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { openR1Database, R1_SCHEMA_VERSION } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1Preferences } from '../electron/main/r1/preferences'
import { createR1Backup } from '../electron/main/r1/backup'
import { R1DataManagement } from '../electron/main/r1/dataManagement'
import { buildDiagnosticExport } from '../electron/main/r1/diagnosticExport'
import { registerDataHandlers } from '../electron/main/ipc/dataHandlers'

vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0-test' }, dialog: {}, ipcMain: {} }))
const directories: string[] = []
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'seamo-data-')); directories.push(directory)
  const path = join(directory, 'r1.sqlite'), db = openR1Database(path), conversations = new R1Conversations(db), session = conversations.start()
  const append = (text: string) => conversations.append({ sessionId: session, turnId: text, role: 'user', body: text, status: 'final' })
  append('SYNTHETIC_PRIVATE_BODY')
  return { db, directory, path, append, data: new R1DataManagement(db, path, directory) }
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

it('exports real content without credentials, legacy raw JSON or unwanted destination overwrites', async () => {
  const s = fixture(), destination = join(s.directory, 'backup.sqlite')
  try {
    s.db.prepare('INSERT INTO legacy_import VALUES(?,?,?)').run('legacy-test', JSON.stringify({ API_KEY: 'SYNTHETIC_SECRET_DO_NOT_EXPORT' }), new Date().toISOString())
    writeFileSync(join(s.directory, 'credentials.enc'), 'SYNTHETIC_VAULT_SECRET')
    await s.data.exportBackup(destination)
    const bytes = readFileSync(destination)
    expect(bytes.includes(Buffer.from('SYNTHETIC_PRIVATE_BODY'))).toBe(true)
    expect(bytes.includes(Buffer.from('SYNTHETIC_SECRET_DO_NOT_EXPORT'))).toBe(false)
    expect(bytes.includes(Buffer.from('SYNTHETIC_VAULT_SECRET'))).toBe(false)
    const exported = new DatabaseSync(destination, { readOnly: true })
    try { expect(exported.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'delete' }) } finally { exported.close() }
    expect(existsSync(`${destination}-wal`)).toBe(false)
    expect(readdirSync(s.directory).some(name => name.startsWith('backup.sqlite.tmp-'))).toBe(false)
    expect(s.db.prepare('SELECT snapshot_json FROM legacy_import').get()).toMatchObject({ snapshot_json: expect.stringContaining('SYNTHETIC_SECRET') })
    await expect(s.data.exportBackup(destination)).rejects.toThrow('BACKUP_ALREADY_EXISTS')
    expect(readFileSync(destination)).toEqual(bytes)
  } finally { s.db.close() }
})

it('requires a fresh owner-bound preview and makes cancellation revoke in-flight snapshot preparation', async () => {
  const s = fixture(), source = join(s.directory, 'source.sqlite')
  try {
    await createR1Backup(s.db, source)
    const preview = await s.data.prepareRestore(1, source)
    expect(preview).toMatchObject({ current: { messages: 1 }, incoming: { messages: 1 }, backupSchema: R1_SCHEMA_VERSION })
    expect(() => s.data.confirm(2, { ticket: preview.ticket, confirmed: true })).toThrow('DATA_PREVIEW_EXPIRED')
    expect(() => s.data.confirm(1, { ticket: preview.ticket, confirmed: false } as never)).toThrow('DATA_CONFIRMATION_REQUIRED')
    s.append('AFTER_PREVIEW')
    expect(() => s.data.confirm(1, { ticket: preview.ticket, confirmed: true })).toThrow('DATA_CHANGED_REVIEW_AGAIN')
    s.data.cancel(1)
    const preparing = s.data.prepareRestore(1, source); s.data.cancel(1)
    await expect(preparing).rejects.toThrow('DATA_PREVIEW_CANCELLED')
    expect(readdirSync(s.directory).filter(name => name.startsWith('.restore-preview-'))).toEqual([])
    expect(s.data.summary().counts.messages).toBe(2)
  } finally { s.db.close() }
})

it('restores the frozen backup only after closing the live connection, preserving choices and a rollback copy', async () => {
  const s = fixture(), source = join(s.directory, 'source.sqlite')
  await createR1Backup(s.db, source); s.append('SYNTHETIC_NEWER_BODY')
  new R1Preferences(s.db).update({ expectedVersion: 1, doNotDisturb: true, reducedMotion: true })
  const preview = await s.data.prepareRestore(7, source)
  writeFileSync(source, 'source was changed after preview')
  const accepted = s.data.confirm(7, { ticket: preview.ticket, confirmed: true })
  expect(s.data.confirm(7, { ticket: preview.ticket, confirmed: true })).toEqual(accepted)
  expect(() => s.data.runAfterDatabaseClosed()).toThrow('DATA_DATABASE_STILL_OPEN')
  s.data.close(); s.db.close()
  expect(s.data.runAfterDatabaseClosed()).toMatchObject({ status: 'succeeded', rollbackAvailable: true })
  const reopened = openR1Database(s.path)
  try {
    const current = new R1DataManagement(reopened, s.path, s.directory)
    expect(current.summary()).toMatchObject({ counts: { messages: 1 }, lastRestore: { operationId: accepted.operationId, status: 'succeeded' } })
    expect(new R1Preferences(reopened).get()).toMatchObject({ doNotDisturb: true, reducedMotion: true })
    const rollback = openR1Database(join(s.directory, readdirSync(s.directory).find(name => name.includes('.pre-restore-'))!))
    try { expect(new R1DataManagement(rollback, '', s.directory).summary().counts.messages).toBe(2) } finally { rollback.close() }
  } finally { reopened.close() }
})

it('leaves current data readable and reports failure when offline restore cannot validate its prepared snapshot', async () => {
  const s = fixture(), source = join(s.directory, 'source.sqlite')
  await createR1Backup(s.db, source)
  const preview = await s.data.prepareRestore(1, source); s.data.confirm(1, { ticket: preview.ticket, confirmed: true })
  const preparedDirectory = readdirSync(s.directory).find(name => name.startsWith('.restore-preview-'))!
  writeFileSync(join(s.directory, preparedDirectory, 'backup.sqlite'), 'broken prepared snapshot')
  s.db.close()
  expect(s.data.runAfterDatabaseClosed()).toMatchObject({ status: 'failed', code: 'RESTORE_FAILED_CURRENT_DATA_PRESERVED' })
  const reopened = openR1Database(s.path)
  try { expect(new R1DataManagement(reopened, s.path, s.directory).summary().counts.messages).toBe(1) } finally { reopened.close() }
})

it('exports only diagnostic stages/statuses and numeric trace fields, never content or arbitrary payloads', () => {
  const s = fixture()
  try {
    s.db.prepare('INSERT INTO event_log VALUES(?,?,?,?,?)').run('synthetic', new Date().toISOString(), 'tool_committed', 'private-owner', JSON.stringify({ body: 'SYNTHETIC_BODY', apiKey: 'SYNTHETIC_KEY', audio: 'SYNTHETIC_AUDIO' }))
    s.db.prepare('INSERT INTO event_log VALUES(?,?,?,?,?)').run('untrusted-kind', new Date().toISOString(), 'synthetic_private_secret', null, '{}')
    const report = buildDiagnosticExport(s.db, { appVersion: '1', assetRelease: '2.5.1', platform: 'darwin', osRelease: 'test', configurationRevision: 1, electronVersion: 'test', nodeVersion: 'test', configured: { VOLCENGINE_ARK_API_KEY: true }, serviceChecks: [] },
      { space_up: 25, tts_play_start: 90, body: 'SYNTHETIC_BODY', apiKey: 'SYNTHETIC_KEY', tts_play_end: 'SYNTHETIC_AUDIO',
        nativeVoice: { receivedAudioBytes: 4800, audioPeak: 22, playbackRebuffers: 1, clearRequests: 2, clearAcks: 2,
          clearTimeouts: 0, maxClearAckMs: 7, connectionRebuilds: 1,
          audioContextState: 'running', body: 'SYNTHETIC_BODY', rawAudio: 'SYNTHETIC_AUDIO', apiKey: 'SYNTHETIC_KEY', lastError: 'SYNTHETIC_KEY' } })
    expect(report.trace.stages).toEqual({ space_up: 25, tts_play_start: 90 })
    expect(report.trace.nativeVoice).toEqual({ receivedAudioBytes: 4800, audioPeak: 22, playbackRebuffers: 1,
      clearRequests: 2, clearAcks: 2, clearTimeouts: 0, maxClearAckMs: 7, connectionRebuilds: 1, audioContextState: 'running' })
    const serialized = JSON.stringify(report)
    for (const secret of ['SYNTHETIC_PRIVATE_BODY', 'SYNTHETIC_BODY', 'SYNTHETIC_KEY', 'SYNTHETIC_AUDIO', 'private-owner', 'synthetic_private_secret']) expect(serialized).not.toContain(secret)
    expect(report.events).toEqual([{ at: expect.any(String), stage: 'tool_committed' }])
  } finally { s.db.close() }
})

it('drains a running backup before the owning database closes and rejects new work during shutdown', async () => {
  const s = fixture(), path = join(s.directory, 'during-quit.sqlite')
  const exporting = s.data.exportBackup(path)
  s.data.close()
  await expect(s.data.exportBackup(join(s.directory, 'late.sqlite'))).rejects.toThrow('DATA_MAINTENANCE_BUSY')
  await s.data.whenIdle(); await exporting; s.db.close()
  const exported = openR1Database(path)
  try { expect(new R1DataManagement(exported, path, s.directory).summary().counts.messages).toBe(1) } finally { exported.close() }
})

it('routes actual file/restore handlers and treats native dialog cancellation as cancellation', async () => {
  const s = fixture(), handlers = new Map<string, (event: unknown, input?: unknown) => unknown>(), restart = vi.fn()
  const dialogs = { save: vi.fn(async (_kind: string): Promise<string | null> => null), open: vi.fn(async (): Promise<string | null> => null) }
  const event = { sender: { id: 9, isDestroyed: () => false, once: vi.fn() } }
  registerDataHandlers(s.data, s.db, { vault: { revision: 2, status: () => { throw new Error('CREDENTIAL_DECRYPT_FAILED') }, diagnosticStatus: () => ({ state: 'CREDENTIAL_DECRYPT_FAILED', configured: null }) } as never, assetRelease: '2.5.1', diagnostics: () => null, requestRestart: restart },
    { handle: (channel, handler) => handlers.set(channel, handler as never) }, dialogs)
  try {
    expect(await handlers.get('r1.data.exportBackup')!(event)).toMatchObject({ ok: true, data: { cancelled: true } })
    expect(await handlers.get('r1.data.prepareRestore')!(event)).toMatchObject({ ok: true, data: { cancelled: true } })
    expect(await handlers.get('r1.data.exportDiagnostics')!(event)).toMatchObject({ ok: true, data: { cancelled: true } })
    const diagnosticPath = join(s.directory, 'diagnostics.json')
    dialogs.save.mockResolvedValueOnce(diagnosticPath)
    expect(await handlers.get('r1.data.exportDiagnostics')!(event)).toMatchObject({ ok: true, data: { cancelled: false } })
    expect(JSON.parse(readFileSync(diagnosticPath, 'utf8'))).toMatchObject({ credentialStorageState: 'CREDENTIAL_DECRYPT_FAILED', configured: null, privacy: { credentialsIncluded: false } })
    expect(statSync(diagnosticPath).mode & 0o777).toBe(0o600)
    const source = join(s.directory, 'source.sqlite'); await createR1Backup(s.db, source)
    let resolveDialog!: (path: string) => void
    dialogs.open.mockImplementationOnce(() => new Promise(resolve => { resolveDialog = resolve }))
    const preparing = handlers.get('r1.data.prepareRestore')!(event)
    await handlers.get('r1.data.cancelRestore')!(event)
    resolveDialog(source)
    expect(await preparing).toMatchObject({ ok: true, data: { cancelled: true } })
    expect(readdirSync(s.directory).filter(name => name.startsWith('.restore-preview-'))).toEqual([])
    dialogs.open.mockResolvedValueOnce(source)
    const response = await handlers.get('r1.data.prepareRestore')!(event) as { data: { preview: { ticket: string } } }
    expect(restart).not.toHaveBeenCalled()
    expect(await handlers.get('r1.data.confirmRestore')!(event, { ticket: response.data.preview.ticket, confirmed: true })).toMatchObject({ ok: true, data: { restartRequired: true } })
    expect(restart).toHaveBeenCalledTimes(1)
  } finally { s.data.close(); s.db.close(); s.data.runAfterDatabaseClosed() }
})
