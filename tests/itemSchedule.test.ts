import { expect, it } from 'vitest'
import type { Item, Reminder } from '../electron/main/r1/items'
import { itemReminder, itemScheduleGroup } from '../src/utils/itemSchedule'
const item: Item = { itemId: 'i', kind: 'todo', title: '验收', body: '', version: 1, completedAt: null, deletedAt: null }
const now = new Date(2026, 9, 21, 12)
const reminder = (day: number, status = 'scheduled', id = String(day)): Reminder => ({ reminderId: id, itemId: 'i', linkPurpose: 'todo_due', body: '验收', dueAtUtc: new Date(2026, 9, day, 9).toISOString(), timezone: 'Asia/Shanghai', scheduleVersion: 1, status, deliveryStatus: 'pending', cancelReason: null })
it('groups past days separately, today by local calendar, and completed independently', () => {
  expect(itemScheduleGroup(item, [reminder(20)], now)).toBe('已过期')
  expect(itemScheduleGroup(item, [reminder(21)], now)).toBe('今天')
  expect(itemScheduleGroup(item, [reminder(22)], now)).toBe('之后')
  expect(itemScheduleGroup(item, [reminder(22, 'cancelled')], now)).toBe('未定时间')
  expect(itemScheduleGroup({ ...item, completedAt: now.toISOString() }, [reminder(20)], now)).toBe('已完成')
})
it('chooses earliest scheduled reminder over old delivery and latest delivered if none scheduled', () => {
  const list = [reminder(19, 'due'), reminder(25), reminder(23), reminder(20, 'missed')]
  expect(itemReminder('i', list)?.reminderId).toBe('23')
  expect(itemReminder('i', list.filter(r => r.status !== 'scheduled'))?.reminderId).toBe('20')
  expect(itemReminder('other', list)).toBeUndefined()
})
it('moves yesterday after midnight without changing the reminder', () => {
  expect(itemScheduleGroup(item, [reminder(21)], new Date(2026, 9, 22, 0, 1))).toBe('已过期')
})
