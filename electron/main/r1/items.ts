import { randomUUID } from 'node:crypto'
import { inTransaction, type R1Database } from './database.js'

export type Item = {
  itemId: string
  kind: 'note' | 'todo'
  title: string
  body: string
  version: number
  completedAt: string | null
  deletedAt: string | null
}

export type Reminder = {
  reminderId: string
  itemId: string | null
  linkPurpose: 'todo_due' | 'independent' | 'other'
  body: string
  dueAtUtc: string
  timezone: string
  scheduleVersion: number
  status: string
  deliveryStatus: string
  cancelReason: string | null
}

export type ActionReceipt = {
  actionId: string
  entityId: string
  entityVersion: number
  status: 'succeeded' | 'unknown'
  detail: string
}

type ItemRow = {
  item_id: string; kind: 'note' | 'todo'; title: string; body: string
  version: number; completed_at: string | null; deleted_at: string | null
  completion_action_id: string | null
}

type ReminderRow = {
  reminder_id: string; item_id: string | null; link_purpose: Reminder['linkPurpose']
  body: string; due_at_utc: string; timezone: string; schedule_version: number
  status: string; delivery_status: string; cancel_reason: string | null
  cancel_action_id: string | null
}

function requiredText(value: string, max: number, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || [...value].length > max) {
    throw new Error(`${field} must contain 1–${max} characters`)
  }
  return value.trim()
}

function optionalText(value: string, max: number, field: string): string {
  if (typeof value !== 'string' || [...value].length > max) {
    throw new Error(`${field} must contain at most ${max} characters`)
  }
  return value.trim()
}

function itemView(row: ItemRow): Item {
  return { itemId: row.item_id, kind: row.kind, title: row.title, body: row.body,
    version: row.version, completedAt: row.completed_at, deletedAt: row.deleted_at }
}

function reminderView(row: ReminderRow): Reminder {
  return { reminderId: row.reminder_id, itemId: row.item_id, linkPurpose: row.link_purpose,
    body: row.body, dueAtUtc: row.due_at_utc, timezone: row.timezone,
    scheduleVersion: row.schedule_version, status: row.status,
    deliveryStatus: row.delivery_status, cancelReason: row.cancel_reason }
}

function itemById(db: R1Database, itemId: string): ItemRow {
  const row = db.prepare('SELECT * FROM items WHERE item_id = ?').get(itemId) as ItemRow | undefined
  if (!row || row.deleted_at) throw new Error('ITEM_NOT_FOUND')
  return row
}

function reminderById(db: R1Database, reminderId: string): ReminderRow {
  const row = db.prepare('SELECT * FROM reminders WHERE reminder_id = ?').get(reminderId) as ReminderRow | undefined
  if (!row) throw new Error('REMINDER_NOT_FOUND')
  return row
}

export function receipt(actionId: string, entityId: string, entityVersion: number, detail: string,
  status: ActionReceipt['status'] = 'succeeded'): ActionReceipt {
  return { actionId, entityId, entityVersion, status, detail }
}

export function runOnce<T>(db: R1Database, actionId: string, request: unknown, operation: () => T): T {
  requiredText(actionId, 160, 'actionId')
  return inTransaction(db, () => {
    const stored = db.prepare('SELECT actual_result_json FROM receipts WHERE action_id = ?')
      .get(actionId) as { actual_result_json: string } | undefined
    if (stored) {
      const replay = JSON.parse(stored.actual_result_json) as { request: unknown; result: T }
      if (JSON.stringify(replay.request) !== JSON.stringify(request)) throw new Error('ACTION_ID_REUSED')
      return replay.result
    }
    const result = operation()
    const main = (result as { receipt?: ActionReceipt }).receipt
    db.prepare('INSERT INTO receipts (action_id, entity_id, entity_version, status, actual_result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(actionId, main?.entityId ?? null, main?.entityVersion ?? null,
        main?.status ?? 'succeeded', JSON.stringify({ request, result }), new Date().toISOString())
    return result
  })
}

export class R1Items {
  constructor(private readonly db: R1Database) {}

  create(input: { actionId: string; kind: Item['kind']; title: string; body: string; sourceRefs?: string[]; preserveBody?: boolean }):
    { item: Item; receipt: ActionReceipt } {
    return runOnce(this.db, input.actionId, input, () => {
      if (input.kind !== 'note' && input.kind !== 'todo') throw new Error('INVALID_ITEM_KIND')
      const title = requiredText(input.title, 80, 'title')
      const body = input.preserveBody ? (optionalText(input.body, 8000, 'body'), input.body) : optionalText(input.body, 8000, 'body')
      if (input.sourceRefs && (input.sourceRefs.length > 50 || new Set(input.sourceRefs).size !== input.sourceRefs.length ||
        input.sourceRefs.some(ref => typeof ref !== 'string' || !ref || [...ref].length > 160))) throw new Error('INVALID_ITEM_SOURCES')
      const id = randomUUID()
      const now = new Date().toISOString()
      this.db.prepare('INSERT INTO items (item_id, kind, title, body, source_ref, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
        .run(id, input.kind, title, body, JSON.stringify(input.sourceRefs ?? []), now, now)
      return { item: itemView(itemById(this.db, id)), receipt: receipt(input.actionId, id, 1, 'item_committed') }
    })
  }

  toolView(itemId: string): { itemId: string; type: Item['kind']; title: string; content: string;
    completed: boolean; version: number; sourceRefs: string[]; createdAt: string; updatedAt: string } {
    const row = itemById(this.db, itemId)
    const meta = this.db.prepare('SELECT source_ref, created_at, updated_at FROM items WHERE item_id = ?').get(itemId) as {
      source_ref: string | null; created_at: string; updated_at: string
    }
    let sourceRefs: string[] = []
    if (meta.source_ref) {
      try { const parsed: unknown = JSON.parse(meta.source_ref); if (Array.isArray(parsed) && parsed.every(ref => typeof ref === 'string')) sourceRefs = parsed }
      catch { sourceRefs = [meta.source_ref] }
    }
    return { itemId, type: row.kind, title: row.title, content: row.body, completed: row.completed_at !== null,
      version: row.version, sourceRefs, createdAt: meta.created_at, updatedAt: meta.updated_at }
  }

  list(): Item[] {
    return (this.db.prepare('SELECT * FROM items WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100')
      .all() as ItemRow[]).map(itemView)
  }

  update(input: { actionId: string; itemId: string; expectedVersion: number;
    kind: Item['kind']; title: string; body: string }): { item: Item; receipt: ActionReceipt } {
    return runOnce(this.db, input.actionId, input, () => {
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
        !['note', 'todo'].includes(input.kind)) throw new Error('INVALID_ITEM_PATCH')
      const current = itemById(this.db, input.itemId)
      if (current.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
      if (current.kind !== input.kind && (current.completed_at || this.db.prepare(
        "SELECT 1 FROM reminders WHERE item_id = ? AND link_purpose = 'todo_due' AND status = 'scheduled' LIMIT 1"
      ).get(input.itemId))) throw new Error('ITEM_KIND_LINKED')
      const title = requiredText(input.title, 80, 'title')
      const body = optionalText(input.body, 8000, 'body')
      this.db.prepare(`UPDATE items SET kind = ?, title = ?, body = ?, version = version + 1,
        updated_at = ? WHERE item_id = ?`).run(input.kind, title, body,
        new Date().toISOString(), input.itemId)
      return { item: itemView(itemById(this.db, input.itemId)),
        receipt: receipt(input.actionId, input.itemId, current.version + 1, 'item_updated') }
    })
  }

  createReminder(input: { actionId: string; itemId?: string; linkPurpose: Reminder['linkPurpose'];
    body: string; dueAtUtc: string; timezone: string; kind?: 'standard' | 'followup' }):
    { reminder: Reminder; receipt: ActionReceipt } {
    return runOnce(this.db, input.actionId, input, () => {
      const body = requiredText(input.body, 8000, 'body')
      if (!['todo_due', 'independent', 'other'].includes(input.linkPurpose)) throw new Error('INVALID_LINK_PURPOSE')
      if (input.linkPurpose === 'todo_due' && (!input.itemId || itemById(this.db, input.itemId).kind !== 'todo')) {
        throw new Error('TODO_DUE_REQUIRES_TODO')
      }
      if (input.linkPurpose === 'todo_due' && input.itemId && itemById(this.db, input.itemId).completed_at) {
        throw new Error('TODO_ALREADY_COMPLETED')
      }
      if (input.itemId) itemById(this.db, input.itemId)
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(input.dueAtUtc) ||
        !Number.isFinite(Date.parse(input.dueAtUtc)) || Date.parse(input.dueAtUtc) <= Date.now())
        throw new Error('INVALID_DUE_TIME')
      try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }) } catch { throw new Error('INVALID_TIMEZONE') }
      const id = randomUUID()
      const now = new Date().toISOString()
      this.db.prepare(`INSERT INTO reminders
        (reminder_id, item_id, link_purpose, kind, body, due_at_utc, timezone,
         schedule_version, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'scheduled', ?, ?)`).run(
        id, input.itemId ?? null, input.linkPurpose, input.kind ?? 'standard', body,
        input.dueAtUtc, input.timezone, now, now)
      return { reminder: reminderView(reminderById(this.db, id)),
        receipt: receipt(input.actionId, id, 1, 'reminder_scheduled') }
    })
  }

  listReminders(): Reminder[] {
    return (this.db.prepare('SELECT * FROM reminders ORDER BY due_at_utc ASC LIMIT 100')
      .all() as ReminderRow[]).map(reminderView)
  }

  reminderToolView(reminderId: string, detailed = false): Record<string, unknown> {
    const row = reminderById(this.db, reminderId)
    const metadata = this.db.prepare('SELECT kind, previous_schedule_version FROM reminders WHERE reminder_id = ?').get(reminderId) as {
      kind: string; previous_schedule_version: number | null }
    const result = { reminderId: row.reminder_id, itemId: row.item_id, content: row.body,
      dueAt: row.due_at_utc, timezone: row.timezone, kind: metadata.kind === 'followup' ? 'follow_up' : 'reminder',
      scheduleVersion: row.schedule_version, status: row.status === 'due' ? 'delivered' : row.status,
      deliveryScope: 'app_running_and_awake' }
    return detailed ? { ...result, linkPurpose: row.link_purpose, cancelReason: row.cancel_reason,
      previousScheduleVersion: metadata.previous_schedule_version } : result
  }
  listToolItems(input: { type?: string | null; query?: string | null; completed?: boolean | null; cursor?: string | null; itemIds?: string[] }) {
    const conditions = ['deleted_at IS NULL'], parameters: Array<string | number> = []
    if (input.type) { conditions.push('kind = ?'); parameters.push(input.type) }
    if (input.query) { conditions.push('(instr(title, ?) > 0 OR instr(body, ?) > 0)'); parameters.push(input.query, input.query) }
    if (input.completed !== null && input.completed !== undefined) conditions.push(input.completed ? 'completed_at IS NOT NULL' : 'completed_at IS NULL')
    if (input.itemIds?.length) { conditions.push(`item_id IN (${input.itemIds.map(() => '?').join(',')})`); parameters.push(...input.itemIds) }
    if (input.cursor) { conditions.push('item_id > ?'); parameters.push(input.cursor) }
    const rows = this.db.prepare(`SELECT item_id FROM items WHERE ${conditions.join(' AND ')} ORDER BY item_id LIMIT 21`).all(...parameters) as { item_id: string }[]
    return { items: rows.slice(0, 20).map(row => this.toolView(row.item_id)), nextCursor: rows.length > 20 ? rows[19].item_id : null }
  }
  listToolReminders(input: { status?: string | null; kind?: string | null; from?: string | null; to?: string | null; cursor?: string | null; reminderIds?: string[] }) {
    const conditions: string[] = ['1=1'], parameters: Array<string | number> = []
    if (input.status) { conditions.push('status = ?'); parameters.push(input.status === 'delivered' ? 'due' : input.status) }
    if (input.kind) { conditions.push('kind = ?'); parameters.push(input.kind === 'follow_up' ? 'followup' : 'standard') }
    for (const key of ['from', 'to'] as const) if (input[key]) {
      const time = new Date(input[key]!)
      if (!Number.isFinite(time.getTime())) throw new Error('INVALID_DUE_TIME')
      conditions.push(`due_at_utc ${key === 'from' ? '>=' : '<='} ?`); parameters.push(time.toISOString())
    }
    if (input.reminderIds?.length) { conditions.push(`reminder_id IN (${input.reminderIds.map(() => '?').join(',')})`); parameters.push(...input.reminderIds) }
    if (input.cursor) { conditions.push('reminder_id > ?'); parameters.push(input.cursor) }
    const rows = this.db.prepare(`SELECT reminder_id FROM reminders WHERE ${conditions.join(' AND ')} ORDER BY reminder_id LIMIT 21`).all(...parameters) as { reminder_id: string }[]
    return { items: rows.slice(0, 20).map(row => this.reminderToolView(row.reminder_id)), nextCursor: rows.length > 20 ? rows[19].reminder_id : null }
  }
  reschedule(input: { actionId: string; reminderId: string; expectedScheduleVersion: number;
    dueAtUtc: string; timezone: string }): { reminder: Reminder; receipt: ActionReceipt } {
    return runOnce(this.db, input.actionId, input, () => {
      const reminder = reminderById(this.db, input.reminderId)
      if (reminder.schedule_version !== input.expectedScheduleVersion) throw new Error('VERSION_CONFLICT')
      if (reminder.status === 'cancelled') throw new Error('REMINDER_CANCELLED')
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(input.dueAtUtc) ||
        !Number.isFinite(Date.parse(input.dueAtUtc)) || Date.parse(input.dueAtUtc) <= Date.now())
        throw new Error('INVALID_DUE_TIME')
      try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }) } catch { throw new Error('INVALID_TIMEZONE') }
      this.db.prepare(`UPDATE reminders SET due_at_utc = ?, timezone = ?, status = 'scheduled',
        delivery_status = 'pending', cancel_reason = NULL, cancel_action_id = NULL,
        previous_schedule_version = schedule_version, schedule_version = schedule_version + 1,
        updated_at = ? WHERE reminder_id = ?`)
        .run(input.dueAtUtc, input.timezone, new Date().toISOString(), input.reminderId)
      return { reminder: reminderView(reminderById(this.db, input.reminderId)),
        receipt: receipt(input.actionId, input.reminderId,
          reminder.schedule_version + 1, 'reminder_rescheduled') }
    })
  }

  cancelReminder(input: { actionId: string; reminderId: string; expectedScheduleVersion: number }):
    { reminder: Reminder; receipt: ActionReceipt } {
    return runOnce(this.db, input.actionId, input, () => {
      const reminder = reminderById(this.db, input.reminderId)
      if (reminder.schedule_version !== input.expectedScheduleVersion) throw new Error('VERSION_CONFLICT')
      if (reminder.status === 'cancelled') throw new Error('REMINDER_ALREADY_CANCELLED')
      const wasDelivered = reminder.status === 'due'
      this.db.prepare(`UPDATE reminders SET status = 'cancelled', cancel_reason = 'user_cancelled',
        cancel_action_id = ?, previous_schedule_version = schedule_version,
        schedule_version = schedule_version + 1, updated_at = ? WHERE reminder_id = ?`)
        .run(input.actionId, new Date().toISOString(), input.reminderId)
      return { reminder: reminderView(reminderById(this.db, input.reminderId)),
        receipt: receipt(input.actionId, input.reminderId, reminder.schedule_version + 1,
          wasDelivered ? 'cancelled_after_delivery_not_retracted' : 'reminder_cancelled') }
    })
  }

  complete(input: { actionId: string; itemId: string; expectedVersion: number; completed: boolean }):
    { item: Item; receipt: ActionReceipt; reminderReceipts: ActionReceipt[] } {
    return runOnce(this.db, input.actionId, input, () => {
      if (typeof input.completed !== 'boolean' || !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1) throw new Error('INVALID_COMPLETION_REQUEST')
      const item = itemById(this.db, input.itemId)
      if (item.kind !== 'todo') throw new Error('NOT_A_TODO')
      if (item.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
      if (Boolean(item.completed_at) === input.completed) throw new Error('NO_STATE_CHANGE')
      const now = new Date().toISOString()
      const reminderReceipts: ActionReceipt[] = []
      if (input.completed) {
        this.db.prepare('UPDATE items SET completed_at = ?, completion_action_id = ?, version = version + 1, updated_at = ? WHERE item_id = ?')
          .run(now, input.actionId, now, input.itemId)
        const linked = this.db.prepare("SELECT * FROM reminders WHERE item_id = ? AND link_purpose = 'todo_due'")
          .all(input.itemId) as ReminderRow[]
        for (const reminder of linked) {
          if (reminder.status !== 'scheduled' || reminder.delivery_status !== 'pending') continue
          const delivered = this.db.prepare('SELECT 1 FROM deliveries WHERE reminder_id = ? AND schedule_version = ?')
            .get(reminder.reminder_id, reminder.schedule_version)
          if (delivered) {
            reminderReceipts.push(receipt(input.actionId, reminder.reminder_id,
              reminder.schedule_version, 'delivery_exists_check_required', 'unknown'))
            continue
          }
          this.db.prepare(`UPDATE reminders SET status = 'cancelled', cancel_reason = 'todo_completed',
            cancel_action_id = ?, previous_schedule_version = schedule_version,
            schedule_version = schedule_version + 1, updated_at = ? WHERE reminder_id = ?`)
            .run(input.actionId, now, reminder.reminder_id)
          reminderReceipts.push(receipt(input.actionId, reminder.reminder_id,
            reminder.schedule_version + 1, 'cancelled_with_todo'))
        }
      } else {
        this.db.prepare('UPDATE items SET completed_at = NULL, completion_action_id = NULL, version = version + 1, updated_at = ? WHERE item_id = ?')
          .run(now, input.itemId)
        if (item.completion_action_id) {
          const linked = this.db.prepare(`SELECT * FROM reminders WHERE item_id = ? AND
            cancel_reason = 'todo_completed' AND cancel_action_id = ? AND status = 'cancelled'`)
            .all(input.itemId, item.completion_action_id) as ReminderRow[]
          for (const reminder of linked) {
            if (Date.parse(reminder.due_at_utc) <= Date.now()) {
              reminderReceipts.push(receipt(input.actionId, reminder.reminder_id,
                reminder.schedule_version, 'past_due_manual_review', 'unknown'))
              continue
            }
            this.db.prepare(`UPDATE reminders SET status = 'scheduled', cancel_reason = NULL,
              cancel_action_id = NULL, previous_schedule_version = schedule_version,
              schedule_version = schedule_version + 1, updated_at = ? WHERE reminder_id = ?`)
              .run(now, reminder.reminder_id)
            reminderReceipts.push(receipt(input.actionId, reminder.reminder_id,
              reminder.schedule_version + 1, 'restored_after_undo'))
          }
        }
      }
      return { item: itemView(itemById(this.db, input.itemId)),
        receipt: receipt(input.actionId, input.itemId, item.version + 1, input.completed ? 'todo_completed' : 'todo_reopened'),
        reminderReceipts }
    })
  }

  deletionPreview(itemId: string): { item: Item; reminders: Pick<Reminder, 'reminderId' | 'scheduleVersion' | 'status'>[] } {
    const item = itemView(itemById(this.db, itemId))
    const reminders = (this.db.prepare('SELECT * FROM reminders WHERE item_id = ?')
      .all(itemId) as ReminderRow[]).map((row) => ({ reminderId: row.reminder_id,
      scheduleVersion: row.schedule_version, status: row.status }))
    return { item, reminders }
  }

  delete(input: { actionId: string; itemId: string; expectedVersion: number;
    reminderDisposition: 'keep' | 'cancel';
    confirmedReminders: { reminderId: string; scheduleVersion: number; status: string }[] }):
    { itemId: string; receipt: ActionReceipt; reminderReceipts: ActionReceipt[] } {
    return runOnce(this.db, input.actionId, input, () => {
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
        !Array.isArray(input.confirmedReminders)) throw new Error('INVALID_DELETE_REQUEST')
      const preview = this.deletionPreview(input.itemId)
      if (preview.item.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
      if (input.reminderDisposition !== 'keep' && input.reminderDisposition !== 'cancel') throw new Error('INVALID_DISPOSITION')
      if (JSON.stringify(preview.reminders) !== JSON.stringify(input.confirmedReminders)) throw new Error('REMINDER_CONFIRMATION_STALE')
      const now = new Date().toISOString()
      const reminderReceipts: ActionReceipt[] = []
      for (const linked of preview.reminders) {
        if (input.reminderDisposition === 'cancel' && linked.status === 'scheduled') {
          this.db.prepare(`UPDATE reminders SET status = 'cancelled', cancel_reason = 'item_deleted',
            cancel_action_id = ?, previous_schedule_version = schedule_version,
            schedule_version = schedule_version + 1, item_id = NULL, updated_at = ? WHERE reminder_id = ?`)
            .run(input.actionId, now, linked.reminderId)
          reminderReceipts.push(receipt(input.actionId, linked.reminderId,
            linked.scheduleVersion + 1, 'cancelled_after_item_deletion'))
        } else {
          this.db.prepare('UPDATE reminders SET item_id = NULL, updated_at = ? WHERE reminder_id = ?')
            .run(now, linked.reminderId)
          reminderReceipts.push(receipt(input.actionId, linked.reminderId,
            linked.scheduleVersion, 'reminder_kept'))
        }
      }
      this.db.prepare('UPDATE items SET deleted_at = ?, version = version + 1, updated_at = ? WHERE item_id = ?')
        .run(now, now, input.itemId)
      return { itemId: input.itemId,
        receipt: receipt(input.actionId, input.itemId, preview.item.version + 1, 'item_deleted'),
        reminderReceipts }
    })
  }

  markMissed(reminderId: string, expectedScheduleVersion: number): boolean {
    return inTransaction(this.db, () => {
      const reminder = reminderById(this.db, reminderId)
      if (reminder.schedule_version !== expectedScheduleVersion || reminder.status !== 'scheduled') return false
      this.db.prepare("INSERT OR IGNORE INTO deliveries(delivery_id,reminder_id,schedule_version,channel,status,created_at) VALUES(?,?,?,'in_app','missed',?)")
        .run(randomUUID(), reminderId, expectedScheduleVersion, new Date().toISOString())
      return this.db.prepare("UPDATE reminders SET status='missed',delivery_status='missed',updated_at=? WHERE reminder_id=? AND schedule_version=? AND status='scheduled'")
        .run(new Date().toISOString(),reminderId,expectedScheduleVersion).changes > 0
    })
  }
  deliver(reminderId: string, expectedScheduleVersion: number, channel: 'in_app'):
    { delivered: boolean; reminder: Reminder } {
    return inTransaction(this.db, () => {
      const reminder = reminderById(this.db, reminderId)
      if (reminder.schedule_version !== expectedScheduleVersion ||
        (reminder.status !== 'scheduled' && reminder.status !== 'due') ||
        Date.parse(reminder.due_at_utc) > Date.now()) return { delivered: false, reminder: reminderView(reminder) }
      const result = this.db.prepare(`INSERT OR IGNORE INTO deliveries
        (delivery_id, reminder_id, schedule_version, channel, status, created_at)
        VALUES (?, ?, ?, ?, 'requested', ?)`).run(randomUUID(), reminderId,
        expectedScheduleVersion, channel, new Date().toISOString())
      if (result.changes > 0) {
        this.db.prepare('UPDATE reminders SET status = ?, delivery_status = ?, updated_at = ? WHERE reminder_id = ?')
          .run('due', 'in_app', new Date().toISOString(), reminderId)
      }
      return { delivered: result.changes > 0, reminder: reminderView(reminderById(this.db, reminderId)) }
    })
  }

  markSystemRequested(reminderId: string, expectedScheduleVersion: number): boolean {
    return inTransaction(this.db, () => {
      const reminder = reminderById(this.db, reminderId)
      if (reminder.schedule_version !== expectedScheduleVersion || reminder.status !== 'due') return false
      const result = this.db.prepare(`UPDATE deliveries SET channel = 'system', status = 'requested'
        WHERE reminder_id = ? AND schedule_version = ? AND channel = 'in_app'`)
        .run(reminderId, expectedScheduleVersion)
      if (result.changes === 0) return false
      this.db.prepare("UPDATE reminders SET delivery_status = 'system_requested', updated_at = ? WHERE reminder_id = ?")
        .run(new Date().toISOString(), reminderId)
      return true
    })
  }

  markSystemRequestFailed(reminderId: string, expectedScheduleVersion: number): void {
    inTransaction(this.db, () => {
      const result = this.db.prepare(`UPDATE deliveries SET channel = 'in_app', status = 'system_failed'
        WHERE reminder_id = ? AND schedule_version = ? AND channel = 'system'`)
        .run(reminderId, expectedScheduleVersion)
      if (result.changes > 0) {
        this.db.prepare("UPDATE reminders SET delivery_status = 'in_app', updated_at = ? WHERE reminder_id = ?")
          .run(new Date().toISOString(), reminderId)
      }
    })
  }
}
