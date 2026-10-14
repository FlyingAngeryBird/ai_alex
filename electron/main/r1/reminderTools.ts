import type { R1Items } from './items.js'
import { validatedReminderTime } from './reminderTime.js'
export const reminderToolAliases = ['notes_list', 'reminders_create', 'reminders_list', 'reminders_reschedule', 'reminders_cancel'] as const
export class R1ReminderTools {
  private knownItems = new Set<string>()
  private knownReminders = new Set<string>()
  constructor(private readonly items: R1Items, private readonly scope: {
    source: { body: string; createdAt: string; timezone: string };
    assertCurrent(): void; requirePersistence(): void; checkSources(refs: string[]): void;
    timeSource?(refs?: string[]): { body: string; createdAt: string; timezone: string }
  }) {}
  observe(output: Record<string, unknown>): void {
    if (output.status !== 'succeeded') return
    const data = output.data as { item?: { itemId: string } } | undefined
    if (data?.item?.itemId) this.knownItems.add(data.item.itemId)
  }
  execute(alias: string, args: Record<string, unknown>, actionId: string): {
    data: Record<string, unknown>; entityId?: string; entityVersion?: number
  } {
    this.scope.assertCurrent()
    if (alias === 'notes_list') {
      const data = this.items.listToolItems(args)
      for (const item of data.items) this.knownItems.add(item.itemId)
      return { data }
    }
    if (alias === 'reminders_list') {
      const data = this.items.listToolReminders(args)
      for (const item of data.items) this.knownReminders.add(item.reminderId as string)
      return { data }
    }
    this.scope.requirePersistence()
    let saved: ReturnType<R1Items['createReminder']>
    if (alias === 'reminders_create') {
      this.scope.checkSources(args.sourceRefs as string[])
      if (args.itemId && !this.knownItems.has(args.itemId as string)) throw new Error('REMINDER_ITEM_NOT_OBSERVED')
      const dueAtUtc = validatedReminderTime({ dueAt: args.dueAt as string, timezone: args.timezone as string }, this.scope.timeSource?.(args.sourceRefs as string[] | undefined) ?? this.scope.source)
      saved = this.items.createReminder({ actionId, itemId: args.itemId as string | null ?? undefined,
        body: args.content as string, dueAtUtc, timezone: args.timezone as string, linkPurpose: args.linkPurpose as 'todo_due' | 'independent' | 'other',
        kind: args.kind === 'follow_up' ? 'followup' : 'standard' })
    } else {
      if (!this.knownReminders.has(args.reminderId as string)) throw new Error('REMINDER_NOT_OBSERVED')
      if (alias === 'reminders_reschedule') {
        const dueAtUtc = validatedReminderTime({ dueAt: args.dueAt as string, timezone: args.timezone as string }, this.scope.timeSource?.(args.sourceRefs as string[] | undefined) ?? this.scope.source)
        saved = this.items.reschedule({ actionId, reminderId: args.reminderId as string,
          expectedScheduleVersion: args.expectedVersion as number, dueAtUtc, timezone: args.timezone as string })
      } else if (alias === 'reminders_cancel') {
        saved = this.items.cancelReminder({ actionId, reminderId: args.reminderId as string, expectedScheduleVersion: args.expectedVersion as number })
      } else throw new Error('REMINDER_TOOL_UNAVAILABLE')
    }
    this.scope.assertCurrent()
    this.knownReminders.add(saved.reminder.reminderId)
    return { data: { reminder: this.items.reminderToolView(saved.reminder.reminderId, alias === 'reminders_create') },
      entityId: saved.reminder.reminderId, entityVersion: saved.reminder.scheduleVersion }
  }
}
