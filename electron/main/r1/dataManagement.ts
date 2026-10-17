import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createR1Backup, restoreR1BackupOffline, validateBackup } from './backup.js'
import { R1_SCHEMA_VERSION, type R1Database } from './database.js'
import { checkCleanupSelection, cleanupR1DataOffline, cleanupFingerprint, type CleanupSelection } from './dataCleanup.js'

export type DataCounts = { sessions: number; messages: number; memories: number; topics: number; items: number;
  reminders: number; tasks: number; artifacts: number; favorites: number; queue: number; feedback: number }
export type RestorePreview = { ticket: string; fileName: string; backupSchema: number; current: DataCounts; incoming: DataCounts; expiresAt: string }
export type RestoreOutcome = { operationId: string; status: 'succeeded' | 'failed'; code: string; completedAt: string; rollbackAvailable: boolean }
export type FileAction = { cancelled: true } | { cancelled: false; fileName: string }
export type CleanupPreview = { ticket: string; selection: CleanupSelection; counts: DataCounts; expiresAt: string }
export type CleanupOutcome = { operationId: string; status: 'succeeded' | 'failed'; completedAt: string; rollbackFileName: string | null }
type Ticket = { owner: number; directory: string; path: string; changes: string; preview: RestorePreview }

export function dataCounts(db: R1Database): DataCounts {
  const count = (table: string, where = '') => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n)
  return { sessions: count('sessions', "WHERE temporary=0 AND status<>'memory_source' AND EXISTS (SELECT 1 FROM messages WHERE messages.session_id=sessions.session_id)"), messages: count('messages'),
    memories: count('memory', 'WHERE deleted_at IS NULL'), topics: count('topics', 'WHERE deleted_at IS NULL'),
    items: count('items', 'WHERE deleted_at IS NULL'), reminders: count('reminders'), tasks: count('agent_tasks'),
    artifacts: count('artifacts'), favorites: count('music_favorites'), queue: count('music_queue'), feedback: count('music_feedback') }
}

/** UI-owned maintenance. No model tool can create or confirm these tickets. */
export class R1DataManagement {
  private tickets = new Map<string, Ticket>()
  private preparing = new Set<number>()
  private generations = new Map<number, number>()
  private pending: Ticket | null = null
  private acceptedId: string | null = null
  private closed = false
  private operations = new Set<Promise<unknown>>()
  private cleanupTickets = new Map<string, { owner: number; preview: CleanupPreview; changes: string }>()
  private pendingCleanup: CleanupPreview | null = null
  private pendingCleanupFingerprint = ''
  constructor(private readonly db: R1Database, private readonly databasePath: string, private readonly userData: string,
    private readonly now: () => number = Date.now) {}
  private changes(): string {
    const total = (this.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const otherConnections = (this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version
    return `${total}:${otherConnections}`
  }
  assertAvailable(): void { if (this.closed || this.pending || this.pendingCleanup) throw new Error('DATA_MAINTENANCE_BUSY') }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    void operation.finally(() => this.operations.delete(operation)).catch(() => undefined)
    return operation
  }
  async whenIdle(): Promise<void> { await Promise.allSettled([...this.operations]) }
  summary(): { counts: DataCounts; schema: number; lastRestore: RestoreOutcome | null; lastCleanup: CleanupOutcome | null } {
    this.assertAvailable()
    return { counts: dataCounts(this.db), schema: R1_SCHEMA_VERSION, lastRestore: this.lastOutcome(), lastCleanup: this.lastCleanup() }
  }
  prepareCleanup(owner: number, input: unknown): CleanupPreview {
    this.assertAvailable(); this.cancel(owner)
    const selection = checkCleanupSelection(input)
    if (selection.sessionId && !this.db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND temporary=0 AND status<>'memory_source'").get(selection.sessionId)) throw new Error('SESSION_NOT_FOUND')
    const counts = dataCounts(this.db)
    if (selection.scopes.includes('history')) counts.messages = Number((this.db.prepare("SELECT COUNT(*) AS n FROM messages m JOIN sessions s ON s.session_id=m.session_id WHERE s.temporary=0 AND s.status<>'memory_source'").get() as { n: number }).n)
    if (selection.sessionId) {
      counts.sessions = 1
      counts.messages = Number((this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id=?').get(selection.sessionId) as { n: number }).n)
    }
    const preview: CleanupPreview = { ticket: randomUUID(), selection, counts, expiresAt: new Date(this.now()+300000).toISOString() }
    this.cleanupTickets.set(preview.ticket, { owner, preview, changes: cleanupFingerprint(this.db,selection) })
    return structuredClone(preview)
  }
  confirmCleanup(owner: number, input: { ticket: string; confirmed: true }): { operationId: string; restartRequired: true } {
    this.assertAvailable()
    if (!input || input.confirmed !== true || typeof input.ticket !== 'string' || Object.keys(input).some(key => !['ticket','confirmed'].includes(key))) throw new Error('DATA_CONFIRMATION_REQUIRED')
    const ticket = this.cleanupTickets.get(input.ticket)
    if (!ticket || ticket.owner !== owner || Date.parse(ticket.preview.expiresAt) <= this.now()) throw new Error('DATA_PREVIEW_EXPIRED')
    if (ticket.changes !== cleanupFingerprint(this.db,ticket.preview.selection)) throw new Error('DATA_CHANGED_REVIEW_AGAIN')
    this.pendingCleanup = ticket.preview; this.pendingCleanupFingerprint=ticket.changes; this.cancel(owner)
    return { operationId: input.ticket, restartRequired: true }
  }
  private lastCleanup(): CleanupOutcome | null {
    try {
      const value = JSON.parse(readFileSync(join(this.userData, 'cleanup-outcome.json'), 'utf8')) as CleanupOutcome
      if (!/^[\da-f-]{36}$/i.test(value.operationId) || !['succeeded','failed'].includes(value.status) || !Number.isFinite(Date.parse(value.completedAt)) ||
        value.rollbackFileName !== null && value.rollbackFileName !== `cleanup-before-${value.operationId}.sqlite`) return null
      return { operationId: value.operationId, status: value.status, completedAt: value.completedAt, rollbackFileName: value.rollbackFileName }
    } catch { return null }
  }
  async exportCleanupBackup(destination: string): Promise<void> {
    this.assertAvailable()
    const last = this.lastCleanup()
    if (!last?.rollbackFileName) throw new Error('DATA_PREVIEW_EXPIRED')
    const source = new DatabaseSync(join(this.userData, last.rollbackFileName), { readOnly: true })
    try { await this.track(createR1Backup(source, destination)) } finally { source.close() }
  }
  async exportBackup(path: string): Promise<void> { this.assertAvailable(); await this.track(createR1Backup(this.db, path)) }
  prepareRestore(owner: number, sourcePath: string): Promise<RestorePreview> {
    this.assertAvailable()
    return this.track(this.prepare(owner, sourcePath))
  }
  private async prepare(owner: number, sourcePath: string): Promise<RestorePreview> {
    if (this.preparing.has(owner)) throw new Error('DATA_MAINTENANCE_BUSY')
    this.cancel(owner); this.preparing.add(owner)
    const generation = this.generations.get(owner) ?? 0
    const directory = mkdtempSync(join(this.userData, '.restore-preview-')), path = join(directory, 'backup.sqlite')
    try {
      validateBackup(sourcePath)
      const source = new DatabaseSync(sourcePath, { readOnly: true })
      try { await createR1Backup(source, path) } finally { source.close() }
      if (this.closed || this.pending || this.pendingCleanup || (this.generations.get(owner) ?? 0) !== generation) throw new Error('DATA_PREVIEW_CANCELLED')
      const snapshot = new DatabaseSync(path, { readOnly: true })
      let incoming: DataCounts, backupSchema: number
      try { incoming = dataCounts(snapshot); backupSchema = (snapshot.prepare('PRAGMA user_version').get() as { user_version: number }).user_version }
      finally { snapshot.close() }
      const preview: RestorePreview = { ticket: randomUUID(), fileName: basename(sourcePath), backupSchema,
        current: dataCounts(this.db), incoming, expiresAt: new Date(this.now() + 300000).toISOString() }
      this.tickets.set(preview.ticket, { owner, path, directory, changes: this.changes(), preview })
      return structuredClone(preview)
    } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
    finally { this.preparing.delete(owner) }
  }
  confirm(owner: number, input: { ticket: string; confirmed: true }): { operationId: string; restartRequired: true } {
    if (this.closed) throw new Error('DATA_MAINTENANCE_BUSY')
    if (!input || input.confirmed !== true || typeof input.ticket !== 'string' || Object.keys(input).some(key => !['ticket', 'confirmed'].includes(key))) throw new Error('DATA_CONFIRMATION_REQUIRED')
    if (this.acceptedId === input.ticket && this.pending?.owner === owner) return { operationId: input.ticket, restartRequired: true }
    const ticket = this.tickets.get(input.ticket)
    if (!ticket || ticket.owner !== owner) throw new Error('DATA_PREVIEW_EXPIRED')
    if (Date.parse(ticket.preview.expiresAt) <= this.now()) { this.cancel(owner); throw new Error('DATA_PREVIEW_EXPIRED') }
    if (this.pending || this.pendingCleanup) throw new Error('DATA_MAINTENANCE_BUSY')
    if (ticket.changes !== this.changes()) throw new Error('DATA_CHANGED_REVIEW_AGAIN')
    validateBackup(ticket.path)
    this.tickets.delete(input.ticket); this.pending = ticket; this.acceptedId = input.ticket
    return { operationId: input.ticket, restartRequired: true }
  }
  cancel(owner: number): void {
    this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1)
    for (const [id, ticket] of this.tickets) if (ticket.owner === owner) { this.tickets.delete(id); rmSync(ticket.directory, { recursive: true, force: true }) }
    for (const [id, ticket] of this.cleanupTickets) if (ticket.owner === owner) this.cleanupTickets.delete(id)
  }
  hasPendingRestore(): boolean { return this.pending !== null || this.pendingCleanup !== null }
  /** Only after every service is drained and the owning connection is closed. */
  runAfterDatabaseClosed(): RestoreOutcome | null {
    if (this.pendingCleanup) {
      if (this.db.isOpen) throw new Error('DATA_DATABASE_STILL_OPEN')
      const preview = this.pendingCleanup, rollbackFileName = `cleanup-before-${preview.ticket}.sqlite`
      let status: CleanupOutcome['status'] = 'failed', rollbackAvailable = false
      try { cleanupR1DataOffline(this.databasePath, preview.selection, join(this.userData, rollbackFileName),this.pendingCleanupFingerprint); status = 'succeeded'; rollbackAvailable = true }
      catch { try { validateBackup(join(this.userData, rollbackFileName)); rollbackAvailable = true } catch {} }
      const value: CleanupOutcome = { operationId: preview.ticket, status, completedAt: new Date().toISOString(), rollbackFileName: rollbackAvailable ? rollbackFileName : null }
      const outcomePath = join(this.userData, 'cleanup-outcome.json'), temporaryPath = `${outcomePath}.${randomUUID()}.tmp`
      try { writeFileSync(temporaryPath, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporaryPath, outcomePath) }
      finally { this.pendingCleanup = null; rmSync(temporaryPath, { force: true }) }
      return null
    }
    if (!this.pending || !this.acceptedId) return null
    if (this.db.isOpen) throw new Error('DATA_DATABASE_STILL_OPEN')
    const ticket = this.pending
    let rollbackAvailable = false, status: RestoreOutcome['status'] = 'failed', code = 'RESTORE_FAILED_CURRENT_DATA_PRESERVED'
    try { restoreR1BackupOffline(this.databasePath, ticket.path); rollbackAvailable = true; status = 'succeeded'; code = 'RESTORE_COMPLETED' }
    catch { /* Do not export raw SQLite errors, paths or user contents. */ }
    const outcome: RestoreOutcome = { operationId: this.acceptedId, status, code, completedAt: new Date().toISOString(), rollbackAvailable }
    const path = join(this.userData, 'restore-outcome.json'), temporary = `${path}.${randomUUID()}.tmp`
    try { writeFileSync(temporary, JSON.stringify(outcome), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path) }
    catch { /* Reporting failure cannot leave an already closed app half running. */ }
    finally {
      try { rmSync(temporary, { force: true }); rmSync(ticket.directory, { recursive: true, force: true }) } catch { /* Cleanup failure must not reopen a closed database or interrupt final quit. */ }
      this.pending = null
    }
    return outcome
  }
  private lastOutcome(): RestoreOutcome | null {
    const path = join(this.userData, 'restore-outcome.json')
    if (!existsSync(path)) return null
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as RestoreOutcome
      if (!/^[\da-f-]{36}$/i.test(value.operationId) || !['succeeded', 'failed'].includes(value.status) ||
        !['RESTORE_COMPLETED', 'RESTORE_FAILED_CURRENT_DATA_PRESERVED'].includes(value.code) || !Number.isFinite(Date.parse(value.completedAt)) || typeof value.rollbackAvailable !== 'boolean') return null
      return { operationId: value.operationId, status: value.status, code: value.code, completedAt: value.completedAt, rollbackAvailable: value.rollbackAvailable }
    } catch { return null }
  }
  close(): void {
    this.closed = true
    for (const owner of new Set([...this.generations.keys(), ...this.preparing, ...[...this.tickets.values()].map(ticket => ticket.owner)])) this.cancel(owner)
    this.cleanupTickets.clear()
  }
}
