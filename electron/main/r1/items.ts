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

function receipt(actionId: string, entityId: string, entityVersion: number, detail: string,
  status: ActionReceipt['status'] = 'succeeded'): ActionReceipt {
  return { actionId, entityId, entityVersion, status, detail }
}

function runOnce<T>(db: R1Database, actionId: string, request: unknown, operation: () => T): T {
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

  create(input: { actionId: string; kind: Item['kind']; title: string; body: string }):
    { item: Item; receipt: ActionReceipt } {
    return runOnce(this.db, input.actionId, input, () => {
      if (input.kind !== 'note' && input.kind !== 'todo') throw new Error('INVALID_ITEM_KIND')
      const title = requiredText(input.title, 80, 'title')
      const body = requiredText(input.body, 8000, 'body')
      const id = randomUUID()
      const now = new Date().toISOString()
      this.db.prepare('INSERT INTO items (item_id, kind, title, body, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .run(id, input.kind, title, body, now, now)
      return { item: itemView(itemById(this.db, id)), receipt: receipt(input.actionId, id, 1, 'item_committed') }
    })
  }

  list(): Item[] {
    return (this.db.prepare('SELECT * FROM items WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100')
      .all() as ItemRow[]).map(itemView)
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
      if (input.itemId) itemById(this.db, input.itemId)
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(input.dueAtUtc) ||
        !Number.isFinite(Date.parse(input.dueAtUtc))) throw new Error('INVALID_DUE_TIME')
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

  complete(input: { actionId: string; itemId: string; expectedVersion: number; completed: boolean }):
    { item: Item; receipt: ActionReceipt; reminderReceipts: ActionReceipt[] } {
    return runOnce(this.db, input.actionId, input, () => {
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

  deliver(reminderId: string, expectedScheduleVersion: number, channel: 'in_app' | 'system'):
    { delivered: boolean; reminder: Reminder } {
    return inTransaction(this.db, () => {
      const reminder = reminderById(this.db, reminderId)
      if (reminder.schedule_version !== expectedScheduleVersion || reminder.status !== 'scheduled' ||
        Date.parse(reminder.due_at_utc) > Date.now()) return { delivered: false, reminder: reminderView(reminder) }
      const result = this.db.prepare(`INSERT OR IGNORE INTO deliveries
        (delivery_id, reminder_id, schedule_version, channel, status, created_at)
        VALUES (?, ?, ?, ?, 'requested', ?)`).run(randomUUID(), reminderId,
        expectedScheduleVersion, channel, new Date().toISOString())
      if (result.changes > 0) {
        this.db.prepare("UPDATE reminders SET status = 'due', delivery_status = 'requested', updated_at = ? WHERE reminder_id = ?")
          .run(new Date().toISOString(), reminderId)
      }
      return { delivered: result.changes > 0, reminder: reminderView(reminderById(this.db, reminderId)) }
    })
  }
}
