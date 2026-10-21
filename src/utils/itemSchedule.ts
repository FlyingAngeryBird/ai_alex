import type { Item, Reminder } from '../../electron/shared/r1Api'

/** Prefer the next scheduled reminder over historical delivery records. */
export function itemReminder(itemId: string, reminders: Reminder[]): Reminder | undefined {
  const linked = reminders.filter(value => value.itemId === itemId && value.status !== 'cancelled')
  const scheduled = linked.filter(value => value.status === 'scheduled')
    .sort((a, b) => Date.parse(a.dueAtUtc) - Date.parse(b.dueAtUtc))
  return scheduled[0] ?? linked.sort((a, b) => Date.parse(b.dueAtUtc) - Date.parse(a.dueAtUtc))[0]
}

export function itemScheduleGroup(item: Item, reminders: Reminder[], now: Date): string {
  if (item.completedAt) return '已完成'
  const reminder = itemReminder(item.itemId, reminders)
  if (!reminder) return '未定时间'
  const due = new Date(reminder.dueAtUtc)
  if (due.toDateString() === now.toDateString()) return '今天'
  return due.getTime() < now.getTime() ? '已过期' : '之后'
}
