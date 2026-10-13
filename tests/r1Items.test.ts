import { describe, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Items } from '../electron/main/r1/items'

function setup() {
  const db = openR1Database(':memory:')
  return { db, items: new R1Items(db) }
}

function future(): string {
  return new Date(Date.now() + 3_600_000).toISOString()
}

describe('R1 item and reminder transactions', () => {
  it('completes a todo, cancels only its pending due reminder, and undoes only that cancellation', () => {
    const { db, items } = setup()
    try {
      const item = items.create({ actionId: 'create', kind: 'todo', title: '报告', body: '完成报告' }).item
      const due = items.createReminder({ actionId: 'due', itemId: item.itemId,
        linkPurpose: 'todo_due', body: '交报告', dueAtUtc: future(), timezone: 'Asia/Shanghai' }).reminder
      const independent = items.createReminder({ actionId: 'independent', itemId: item.itemId,
        linkPurpose: 'independent', body: '复盘', dueAtUtc: future(), timezone: 'Asia/Shanghai' }).reminder
      const complete = items.complete({ actionId: 'complete', itemId: item.itemId,
        expectedVersion: 1, completed: true })
      expect(complete.item.version).toBe(2)
      expect(complete.reminderReceipts).toEqual([expect.objectContaining({
        entityId: due.reminderId, detail: 'cancelled_with_todo' })])
      expect(items.listReminders().find((r) => r.reminderId === independent.reminderId)?.status).toBe('scheduled')
      expect(items.complete({ actionId: 'complete', itemId: item.itemId,
        expectedVersion: 1, completed: true })).toEqual(complete)
      expect(() => items.complete({ actionId: 'complete', itemId: item.itemId,
        expectedVersion: 2, completed: true })).toThrow('ACTION_ID_REUSED')
      const undo = items.complete({ actionId: 'undo', itemId: item.itemId,
        expectedVersion: 2, completed: false })
      expect(undo.reminderReceipts).toEqual([expect.objectContaining({
        entityId: due.reminderId, detail: 'restored_after_undo' })])
      expect(items.listReminders().find((r) => r.reminderId === due.reminderId)?.scheduleVersion).toBe(3)
    } finally { db.close() }
  })

  it('keeps reminders by default after a confirmed deletion and refuses stale confirmation', () => {
    const { db, items } = setup()
    try {
      const item = items.create({ actionId: 'create', kind: 'note', title: '记事', body: '内容' }).item
      const stale = items.deletionPreview(item.itemId)
      const reminder = items.createReminder({ actionId: 'remind', itemId: item.itemId,
        linkPurpose: 'independent', body: '提醒', dueAtUtc: future(), timezone: 'Asia/Shanghai' }).reminder
      expect(() => items.delete({ actionId: 'delete-stale', itemId: item.itemId,
        expectedVersion: 1, reminderDisposition: 'keep', confirmedReminders: stale.reminders }))
        .toThrow('REMINDER_CONFIRMATION_STALE')
      expect(items.list()).toHaveLength(1)
      const current = items.deletionPreview(item.itemId)
      const result = items.delete({ actionId: 'delete', itemId: item.itemId,
        expectedVersion: 1, reminderDisposition: 'keep', confirmedReminders: current.reminders })
      expect(result.reminderReceipts[0].detail).toBe('reminder_kept')
      expect(items.list()).toHaveLength(0)
      expect(items.listReminders().find((r) => r.reminderId === reminder.reminderId))
        .toMatchObject({ status: 'scheduled', itemId: null })
    } finally { db.close() }
  })

  it('does not deliver a cancelled or obsolete schedule version and deduplicates delivery', () => {
    const { db, items } = setup()
    try {
      const item = items.create({ actionId: 'create', kind: 'todo', title: '事', body: '事' }).item
      const reminder = items.createReminder({ actionId: 'remind', itemId: item.itemId,
        linkPurpose: 'todo_due', body: '提醒', dueAtUtc: new Date(Date.now() - 1000).toISOString(),
        timezone: 'Asia/Shanghai' }).reminder
      expect(items.deliver(reminder.reminderId, 1, 'in_app').delivered).toBe(true)
      expect(items.deliver(reminder.reminderId, 1, 'in_app').delivered).toBe(false)
      const complete = items.complete({ actionId: 'complete', itemId: item.itemId,
        expectedVersion: 1, completed: true })
      expect(complete.reminderReceipts).toHaveLength(0)
      expect(items.listReminders()[0].status).toBe('due')
    } finally { db.close() }
  })

  it('rejects invalid reminder times and keeps the item committed for a separate retry', () => {
    const { db, items } = setup()
    try {
      const item = items.create({ actionId: 'create', kind: 'note', title: '事', body: '内容' }).item
      expect(() => items.createReminder({ actionId: 'bad-reminder', itemId: item.itemId,
        linkPurpose: 'independent', body: '提醒', dueAtUtc: '明晚', timezone: 'Asia/Shanghai' }))
        .toThrow('INVALID_DUE_TIME')
      expect(items.list()).toHaveLength(1)
      expect(items.listReminders()).toHaveLength(0)
    } finally { db.close() }
  })
})
