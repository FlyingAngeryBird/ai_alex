import { app, dialog, ipcMain } from 'electron'
import { basename } from 'node:path'
import { writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { buildDiagnosticExport } from '../r1/diagnosticExport.js'
import type { R1Database } from '../r1/database.js'
import type { R1DataManagement } from '../r1/dataManagement.js'
import type { CredentialVault } from '../r1/credentials.js'
import type { R1ServiceDiagnostics } from '../r1/serviceDiagnostics.js'
type Event = { sender: { id: number; isDestroyed(): boolean; once(name: 'destroyed', listener: () => void): void } }
type Ipc = { handle(channel: string, handler: (event: Event, input?: unknown) => unknown): void }
type FileDialogs = { save(kind: 'backup' | 'diagnostic'): Promise<string | null>; open(): Promise<string | null> }
const fileDialogs: FileDialogs = {
  async save(kind) {
    const result = await dialog.showSaveDialog({ title: kind === 'backup' ? '导出内容备份' : '导出诊断',
      defaultPath: kind === 'backup' ? `Seamo-R1-${new Date().toISOString().slice(0, 10)}.sqlite` : 'Seamo-R1-diagnostics.json',
      filters: [{ name: kind === 'backup' ? 'Seamo 内容备份' : '诊断 JSON', extensions: [kind === 'backup' ? 'sqlite' : 'json'] }] })
    return result.canceled || !result.filePath ? null : result.filePath
  },
  async open() {
    const result = await dialog.showOpenDialog({ title: '选择要恢复的内容备份', properties: ['openFile'], filters: [{ name: 'Seamo 内容备份', extensions: ['sqlite'] }] })
    return result.canceled || result.filePaths.length !== 1 ? null : result.filePaths[0]
  }
}
export function registerDataHandlers(data: R1DataManagement, db: R1Database, options: { vault: CredentialVault; assetRelease: string;
  diagnostics(): R1ServiceDiagnostics | null; requestRestart(): void }, ipc: Ipc = ipcMain, dialogs: FileDialogs = fileDialogs): void {
  const busy = new Set<number>(), observed = new Set<number>(), generations = new Map<number, number>()
  const cancel = (owner: number) => { generations.set(owner, (generations.get(owner) ?? 0) + 1); data.cancel(owner) }
  const codes = new Set(['DATA_MAINTENANCE_BUSY', 'DATA_PREVIEW_CANCELLED', 'DATA_PREVIEW_EXPIRED', 'DATA_CONFIRMATION_REQUIRED',
    'DATA_SCOPE_REQUIRED', 'SESSION_NOT_FOUND',
    'DATA_CHANGED_REVIEW_AGAIN', 'BACKUP_ALREADY_EXISTS', 'BACKUP_SCHEMA_UNSUPPORTED', 'BACKUP_INTEGRITY_FAILED', 'BACKUP_RELATIONS_INVALID'])
  const fail = (error: unknown) => ({ ok: false, error: { code: error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST' ? 'BACKUP_ALREADY_EXISTS' : error instanceof Error && codes.has(error.message) ? error.message : 'DATA_OPERATION_FAILED', message: '操作未完成，当前数据保留。' } })
  const handle = (channel: string, action: (event: Event, input?: unknown) => unknown) => ipc.handle(channel, async (event, input) => {
    const owner = event.sender.id
    if (!observed.has(owner)) { observed.add(owner); event.sender.once('destroyed', () => { observed.delete(owner); cancel(owner) }) }
    if (busy.has(owner)) return fail(new Error('DATA_MAINTENANCE_BUSY'))
    busy.add(owner)
    try { return { ok: true, data: await action(event, input) } } catch (error) { return fail(error) } finally { busy.delete(owner) }
  })
  handle('r1.data.summary', () => data.summary())
  handle('r1.data.prepareCleanup', (event, input) => data.prepareCleanup(event.sender.id, input))
  handle('r1.data.confirmCleanup', (event, input) => {
    const receipt = data.confirmCleanup(event.sender.id, input as { ticket: string; confirmed: true })
    options.requestRestart(); return receipt
  })
  handle('r1.data.exportCleanupBackup', async event => {
    const path = await dialogs.save('backup')
    if (!path || event.sender.isDestroyed()) return { cancelled: true }
    await data.exportCleanupBackup(path); return { cancelled: false, fileName: basename(path) }
  })
  handle('r1.data.exportBackup', async event => {
    const path = await dialogs.save('backup')
    if (!path || event.sender.isDestroyed()) return { cancelled: true }
    await data.exportBackup(path); return { cancelled: false, fileName: basename(path) }
  })
  handle('r1.data.prepareRestore', async event => {
    const owner = event.sender.id, generation = generations.get(owner) ?? 0
    const path = await dialogs.open()
    if (!path || event.sender.isDestroyed() || generation !== (generations.get(owner) ?? 0)) return { cancelled: true }
    return { cancelled: false, preview: await data.prepareRestore(owner, path) }
  })
  // Cancellation must be able to revoke a preview while its SQLite snapshot is
  // still being prepared. It is intentionally outside the owner busy gate.
  ipc.handle('r1.data.cancelRestore', event => { cancel(event.sender.id); return { ok: true, data: null } })
  handle('r1.data.confirmRestore', (event, input) => {
    const receipt = data.confirm(event.sender.id, input as { ticket: string; confirmed: true })
    options.requestRestart(); return receipt
  })
  handle('r1.data.exportDiagnostics', async (event, input) => {
    const path = await dialogs.save('diagnostic')
    if (!path || event.sender.isDestroyed()) return { cancelled: true }
    data.assertAvailable()
    const credentialState = options.vault.diagnosticStatus()
    const report = buildDiagnosticExport(db, { appVersion: app.getVersion(), assetRelease: options.assetRelease, platform: process.platform,
      osRelease: release(), electronVersion: process.versions.electron ?? '', nodeVersion: process.versions.node,
      configurationRevision: options.vault.revision, configured: credentialState.configured, credentialStorageState: credentialState.state, serviceChecks: options.diagnostics()?.latestReports() ?? [] }, (input as { voiceTrace?: unknown } | undefined)?.voiceTrace)
    writeFileSync(path, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
    return { cancelled: false, fileName: basename(path) }
  })
}
