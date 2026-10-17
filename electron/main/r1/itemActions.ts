import { randomUUID } from 'node:crypto'
import type { R1Database } from './database.js'
import { R1Items } from './items.js'
import type { R1Artifacts } from './artifacts.js'
import { exportItems, type ItemExportInput } from './itemExport.js'
import { exportArtifact } from './artifactExport.js'

/** Same bounded confirmation window as the existing memory confirmations. */
export const ITEM_ACTION_TTL_MS = 300_000
const MAX_PENDING = 8

export type ItemActionKind = 'confirm_item_delete' | 'export'
export type ItemActionReminder = { reminderId: string; scheduleVersion: number; status: string }
export type ItemActionView = {
  ticket: string
  action: ItemActionKind
  expiresAt: string
  data: {
    item?: { itemId: string; title: string; version: number; type: 'note' | 'todo' }
    reminders?: ItemActionReminder[]
    format?: 'txt' | 'md'
    items?: { itemId: string; title: string; version: number }[]
    artifact?: { artifactId: string; title: string; version: number }
  }
}
export type ItemActionTaskBinding = { taskId: string; runId: string; goalVersion: number }
type Context = {
  ownerId: number
  sessionId: string
  temporary: boolean
  task?: ItemActionTaskBinding | null
  assertCurrent(): void
}
export type ItemActionTarget =
  | { reason: 'model'; kind: 'delete'; itemId: string; expectedVersion: number }
  | { reason: 'model'; kind: 'export'; itemIds: string[]; artifactId: null; artifactVersion: null; format: 'txt' | 'md' }
  | { reason: 'model'; kind: 'export'; itemIds: []; artifactId: string; artifactVersion: number; format: 'txt' | 'md' }

type Pending = {
  view: ItemActionView
  context: Context
  itemVersion?: number
  reminders?: ItemActionReminder[]
  exportItems?: ItemExportInput
  exportArtifact?: { artifactId: string; expectedVersion: number; format: 'txt' | 'md' }
}
type Settled = { kind: 'deleted' | 'exported' | 'cancelled' | 'error'; at: number; value: unknown }

/**
 * Model-initiated delete/export never commits directly. It freezes the real
 * Item/Artifact versions and keeps only an opaque ticket in the model's view;
 * the trusted renderer confirms with its own webContents identity.
 */
export class R1ItemActions {
  private readonly pending = new Map<string, Pending>()
  private readonly settled = new Map<string, { ownerId: number; value: Settled }>()
  private readonly items: R1Items
  constructor(private readonly db: R1Database, items: R1Items, private readonly artifacts: R1Artifacts,
    private readonly options: {
      notify(ownerId: number, view: ItemActionView | null): void
      choose(name: string, extension: string): Promise<string | null>
      isSessionCurrent(context: { sessionId: string; temporary: boolean }): boolean
      isOwnerAlive?(ownerId: number): boolean
      isTaskCurrent?(task: ItemActionTaskBinding): boolean
      onTaskReceipt?(taskId: string): void
      onChanged?(change: { kind: 'deleted' | 'exported'; itemId: string | null; artifactId: string | null }): void
      now?: () => number
      ttlMs?: number
    }) { this.items = items }
  private now(): number { return this.options.now?.() ?? Date.now() }
  private ttl(): number { return this.options.ttlMs ?? ITEM_ACTION_TTL_MS }
  private prune(): void {
    const now = this.now()
    for (const [id, record] of this.pending) if (Date.parse(record.view.expiresAt) <= now) this.drop(id, record.context.ownerId)
    for (const [id, record] of this.settled) if (record.value.at + this.ttl() <= now) this.settled.delete(id)
  }
  private drop(ticket: string, ownerId: number): void {
    if (!this.pending.delete(ticket)) return
    this.options.notify(ownerId, null)
  }
  private bounded(): void {
    this.prune()
    if (this.pending.size >= MAX_PENDING) throw new Error('ITEM_ACTION_LIMIT')
  }
  private notify(context: Context, view: ItemActionView): ItemActionView {
    const copy = structuredClone(view)
    if (context.ownerId > 0) this.options.notify(context.ownerId, copy)
    return copy
  }
  private existing(ticket: string): Pending | undefined { return this.pending.get(ticket) }

  offer(context: Context, target:
    { kind: 'delete'; itemId: string; expectedVersion: number } |
    { kind: 'export'; itemIds: string[]; artifactId: null; artifactVersion: null; format: 'txt' | 'md' } |
    { kind: 'export'; itemIds: []; artifactId: string; artifactVersion: number; format: 'txt' | 'md' }): ItemActionView {
    if (target.kind === 'delete') return this.offerDelete(context, { itemId: target.itemId, expectedVersion: target.expectedVersion })
    return this.offerExport(context, { ...target, reason: 'model' } as Extract<ItemActionTarget, { kind: 'export' }>)
  }

  offerDelete(context: Context, input: { itemId: string; expectedVersion: number; ticket?: string }): ItemActionView {
    context.assertCurrent()
    this.prune()
    if (input.ticket && this.settled.has(input.ticket)) throw new Error('ITEM_ACTION_ALREADY_SETTLED')
    const preview = this.items.deletionPreview(input.itemId)
    if (preview.item.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
    const ticket = input.ticket ?? randomUUID()
    const previous = this.existing(ticket)
    if (previous) {
      if (previous.view.action !== 'confirm_item_delete' || previous.view.data.item?.itemId !== input.itemId) throw new Error('ITEM_ACTION_ALREADY_PENDING')
      return structuredClone(previous.view)
    }
    if ([...this.pending.values()].some(record => record.view.action === 'confirm_item_delete' &&
      record.view.data.item?.itemId === input.itemId && record.context.sessionId === context.sessionId)) throw new Error('ITEM_ACTION_ALREADY_PENDING')
    // One visible confirmation per window keeps the renderer and the model in
    // sync; a newer request supersedes an older unconfirmed preview.
    for (const [id, record] of this.pending) if (record.context.ownerId === context.ownerId) this.drop(id, context.ownerId)
    this.bounded()
    const view: ItemActionView = { ticket, action: 'confirm_item_delete',
      expiresAt: new Date(this.now() + this.ttl()).toISOString(),
      data: { item: { itemId: preview.item.itemId, title: preview.item.title, type: preview.item.kind,
        version: preview.item.version }, reminders: structuredClone(preview.reminders) } }
    this.pending.set(ticket, { view, context: { ...context, assertCurrent: () => context.assertCurrent() },
      itemVersion: preview.item.version, reminders: structuredClone(preview.reminders) })
    return this.notify(context, view)
  }

  offerExport(context: Context, target: Extract<ItemActionTarget, { kind: 'export' }>, ticket?: string): ItemActionView {
    context.assertCurrent(); this.prune()
    if (ticket && this.settled.has(ticket)) throw new Error('ITEM_ACTION_ALREADY_SETTLED')
    if (ticket && this.existing(ticket)) {
      const previous = this.existing(ticket)!
      if (previous.view.action !== 'export') throw new Error('ITEM_ACTION_ALREADY_PENDING')
      return structuredClone(previous.view)
    }
    for (const [id, record] of this.pending) if (record.context.ownerId === context.ownerId) this.drop(id, context.ownerId)
    this.bounded()
    const view: ItemActionView = { ticket: ticket ?? randomUUID(), action: 'export',
      expiresAt: new Date(this.now() + this.ttl()).toISOString(), data: { format: target.format } }
    let frozen: Pending
    if (target.itemIds.length) {
      const snapshots = target.itemIds.map(itemId => this.items.toolView(itemId))
      view.data.items = snapshots.map(item => ({ itemId: item.itemId, title: item.title, version: item.version }))
      frozen = { view, context: { ...context, assertCurrent: () => context.assertCurrent() },
        exportItems: { items: snapshots.map(item => ({ itemId: item.itemId, expectedVersion: item.version })), format: target.format } }
    } else {
      const artifact = this.artifacts.get(target.artifactId!, context.temporary ? context.sessionId : null)
      if (artifact.version !== target.artifactVersion) throw new Error('VERSION_CONFLICT')
      view.data.artifact = { artifactId: artifact.artifactId, title: artifact.title, version: artifact.version }
      frozen = { view, context: { ...context, assertCurrent: () => context.assertCurrent() },
        exportArtifact: { artifactId: artifact.artifactId, expectedVersion: artifact.version, format: target.format } }
    }
    const output = this.notify(context, view)
    this.pending.set(view.ticket, frozen)
    return output
  }

  revokeOwner(ownerId: number): void {
    for (const [id, record] of this.pending) if (record.context.ownerId === ownerId) this.drop(id, ownerId)
  }
  revokeSession(sessionId: string): void {
    for (const [id, record] of this.pending) if (record.context.sessionId === sessionId) this.drop(id, record.context.ownerId)
  }
  revokeAll(): void { for (const [id, record] of this.pending) this.drop(id, record.context.ownerId) }
  revokePending(actionIds: string[], reason = 'TASK_STOPPED'): string[] {
    const removed: string[] = []
    for (const id of actionIds) {
      const record = this.pending.get(id)
      if (!record) continue
      removed.push(id)
      this.settled.set(id, { ownerId: record.context.ownerId, value: { kind: 'error', at: this.now(), value: reason } })
      this.drop(id, record.context.ownerId)
    }
    return removed
  }

  private readonly inFlight = new Map<string, Promise<unknown>>()

  async resolve(ownerId: number, input: { ticket: string; decision: 'delete' | 'export' | 'cancel'; reminderDisposition?: 'keep' | 'cancel' }): Promise<unknown> {
    if (!input || typeof input.ticket !== 'string' || !input.ticket || !['delete', 'export', 'cancel'].includes(input.decision)) {
      throw new Error('INVALID_ITEM_ACTION')
    }
    const settled = this.settled.get(input.ticket)
    if (settled) {
      if (settled.ownerId !== ownerId) throw new Error('ITEM_ACTION_OWNER_MISMATCH')
      if (settled.value.kind === 'error') throw new Error(String(settled.value.value))
      return structuredClone(settled.value.value)
    }
    const record = this.pending.get(input.ticket)
    if (!record || record.context.ownerId !== ownerId) throw new Error('ITEM_ACTION_NOT_FOUND')
    // Concurrent clicks/requests share one commit: only the first may open the
    // native dialog or write; replays receive the same promise/result.
    const running = this.inFlight.get(input.ticket)
    if (running) return running
    const promise = this.resolveOnce(ownerId, input, record)
    this.inFlight.set(input.ticket, promise)
    try { return await promise } finally { if (this.inFlight.get(input.ticket) === promise) this.inFlight.delete(input.ticket) }
  }

  private trustedFailure(record: Pending, ownerId: number): string | null {
    if (this.pending.get(record.view.ticket) !== record) return 'ITEM_ACTION_REVOKED'
    if (Date.parse(record.view.expiresAt) <= this.now()) return 'ITEM_ACTION_EXPIRED'
    if (!this.options.isSessionCurrent({ sessionId: record.context.sessionId, temporary: record.context.temporary })) return 'ITEM_ACTION_SESSION_CHANGED'
    if (this.options.isOwnerAlive && !this.options.isOwnerAlive(ownerId)) return 'ITEM_ACTION_OWNER_MISMATCH'
    if (record.context.task && this.options.isTaskCurrent && !this.options.isTaskCurrent(record.context.task)) return 'ITEM_ACTION_TASK_STALE'
    return null
  }
  /** Real current-state check, also called by the export services after their dialog and before writing. */
  private assertTrusted(record: Pending, ownerId: number): void {
    const code = this.trustedFailure(record, ownerId)
    if (code) throw new Error(code)
  }
  /** Every confirmed attempt has one terminal state; repeated requests replay it. */
  private fail(record: Pending, ownerId: number, code: string): never {
    if (this.pending.get(record.view.ticket) === record) this.drop(record.view.ticket, ownerId)
    this.settled.set(record.view.ticket, { ownerId, value: { kind: 'error', at: this.now(), value: code } })
    throw new Error(code)
  }
  private finish(record: Pending, ownerId: number, value: Record<string, unknown>, kind: 'exported' | 'deleted', change: {
    itemId: string | null; artifactId: string | null
  }): Record<string, unknown> {
    this.drop(record.view.ticket, ownerId)
    this.settled.set(record.view.ticket, { ownerId, value: { kind, at: this.now(), value } })
    try { this.options.onChanged?.(kind === 'deleted' ? { kind: 'deleted', ...change } : { kind: 'exported', ...change }) } catch { /* committed */ }
    if (record.context.task) { try { this.options.onTaskReceipt?.(record.context.task.taskId) } catch { /* receipt already persisted */ } }
    return structuredClone(value)
  }

  private async resolveOnce(ownerId: number, input: { ticket: string; decision: 'delete' | 'export' | 'cancel'; reminderDisposition?: 'keep' | 'cancel' }, record: Pending): Promise<unknown> {
    const stale = this.trustedFailure(record, ownerId)
    if (stale) return this.fail(record, ownerId, stale)
    if (input.decision === 'cancel') {
      this.drop(input.ticket, ownerId)
      const value = { cancelled: true as const }
      this.settled.set(input.ticket, { ownerId, value: { kind: 'cancelled', at: this.now(), value } })
      return value
    }
    if (input.decision === 'delete') return this.commitDelete(record, ownerId, input.reminderDisposition)
    if (record.view.action !== 'export') throw new Error('INVALID_ITEM_ACTION')
    return this.commitExport(record, ownerId)
  }

  private commitDelete(record: Pending, ownerId: number, disposition?: 'keep' | 'cancel') {
    if (record.view.action !== 'confirm_item_delete' || !record.view.data.item) throw new Error('INVALID_ITEM_ACTION')
    if (disposition !== 'keep' && disposition !== 'cancel') throw new Error('INVALID_DISPOSITION')
    const itemId = record.view.data.item.itemId
    // Re-read the real domain state: an Item edit, reminder reschedule or new
    // linked reminder after the preview makes this confirmation stale.
    let preview: ReturnType<R1Items['deletionPreview']>
    try { preview = this.items.deletionPreview(itemId) } catch { return this.fail(record, ownerId, 'ITEM_ACTION_STALE') }
    if (preview.item.version !== record.itemVersion ||
      JSON.stringify(preview.reminders) !== JSON.stringify(record.reminders)) {
      return this.fail(record, ownerId, 'ITEM_ACTION_STALE')
    }
    let result: ReturnType<R1Items['delete']>
    try {
      result = this.items.delete({ actionId: record.view.ticket, itemId, expectedVersion: record.itemVersion!,
        reminderDisposition: disposition, confirmedReminders: record.reminders! })
    } catch (error) {
      return this.fail(record, ownerId, error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'ITEM_DELETE_FAILED')
    }
    // Only reminders the domain actually kept remain linked to the deleted Item.
    const remainingReminderIds = result.reminderReceipts
      .filter(receipt => receipt.detail === 'reminder_kept').map(receipt => receipt.entityId)
    // A link failure keeps the pending ticket so the idempotent domain replay can retry it.
    if (record.context.task) this.linkTaskReceipt(record)
    return this.finish(record, ownerId, { cancelled: false, itemId: result.itemId, deleted: true,
      remainingReminderIds, reminderReceipts: result.reminderReceipts }, 'deleted', { itemId, artifactId: null })
  }

  private linkTaskReceipt(record: Pending): void {
    const task = record.context.task!
    const row = this.db.prepare('SELECT task_id FROM receipts WHERE action_id = ?')
      .get(record.view.ticket) as { task_id: string | null } | undefined
    if (!row) throw new Error('TASK_RECEIPT_RECONCILIATION_REQUIRED')
    if (row.task_id && row.task_id !== task.taskId) throw new Error('TASK_RECEIPT_SCOPE_INVALID')
    this.db.prepare('UPDATE receipts SET task_id = ?, run_id = ? WHERE action_id = ?')
      .run(task.taskId, task.runId, record.view.ticket)
  }

  private finishCancelled(record: Pending, ownerId: number): Record<string, unknown> {
    this.drop(record.view.ticket, ownerId)
    const value = { cancelled: true as const }
    this.settled.set(record.view.ticket, { ownerId, value: { kind: 'cancelled', at: this.now(), value } })
    return value
  }

  private async commitExport(record: Pending, ownerId: number) {
    const task = record.context.task ? { taskId: record.context.task.taskId, runId: record.context.task.runId } : null
    const assertCurrent = () => this.assertTrusted(record, ownerId)
    try {
      if (record.exportItems) {
        const result = await exportItems(this.db, record.exportItems,
          () => JSON.stringify([record.context.temporary, record.context.sessionId]), this.options.choose,
          { actionId: record.view.ticket, task, assertCurrent })
        if (result.cancelled) return this.finishCancelled(record, ownerId)
        return this.finish(record, ownerId, result as unknown as Record<string, unknown>, 'exported', { itemId: null, artifactId: null })
      }
      const artifact = record.exportArtifact!
      const result = await exportArtifact(this.artifacts, artifact,
        () => record.context.temporary ? record.context.sessionId : null, this.options.choose,
        { db: this.db, actionId: record.view.ticket, task, assertCurrent })
      if (result.cancelled) return this.finishCancelled(record, ownerId)
      return this.finish(record, ownerId, result as unknown as Record<string, unknown>, 'exported', { itemId: null, artifactId: artifact.artifactId })
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'ITEM_EXPORT_FAILED'
      return this.fail(record, ownerId, code)
    }
  }
}
