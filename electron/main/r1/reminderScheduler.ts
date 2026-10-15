import { Notification, BrowserWindow } from 'electron'
import { R1Items } from './items.js'
import type { R1Database } from './database.js'
import { R1Preferences } from './preferences.js'

export type ReminderDueEvent = {
  reminderId: string
  body: string
  dueAtUtc: string
  systemRequested: boolean
  silent?: boolean
}

type NotificationPort = {
  isSupported(): boolean
  show(title: string, body: string, options?: { silent: boolean }): void
}

type WindowPort = {
  broadcast(event: ReminderDueEvent): void
}

export class ReminderScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly items: R1Items

  constructor(private readonly db: R1Database,
    private readonly notifications: NotificationPort,
    private readonly windows: WindowPort, private readonly isQuiet: () => boolean = () => false) {
    this.items = new R1Items(db)
  }

  start(): void {
    if (this.timer) return
    this.tick()
    this.timer = setInterval(() => this.tick(), 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  tick(now = new Date()): void {
    const due = this.db.prepare(`SELECT reminder_id, schedule_version, body, due_at_utc
      FROM reminders WHERE status = 'scheduled' AND due_at_utc <= ?
      ORDER BY due_at_utc LIMIT 50`).all(now.toISOString()) as {
      reminder_id: string; schedule_version: number; body: string; due_at_utc: string
    }[]
    for (const row of due) {
      if (!this.items.deliver(row.reminder_id, row.schedule_version, 'in_app').delivered) continue
      let systemRequested = false
      const silent = this.isQuiet()
      if (this.notifications.isSupported() &&
        this.items.markSystemRequested(row.reminder_id, row.schedule_version)) {
        try {
          this.notifications.show('Seamo AI 提醒', row.body, { silent })
          systemRequested = true
        } catch {
          // The in-app record remains visible. Do not claim the OS showed a notification.
          this.items.markSystemRequestFailed(row.reminder_id, row.schedule_version)
        }
      }
      this.windows.broadcast({ reminderId: row.reminder_id, body: row.body,
        dueAtUtc: row.due_at_utc, systemRequested, silent })
    }
  }
}

export function createElectronReminderScheduler(db: R1Database): ReminderScheduler {
  return new ReminderScheduler(db, {
    isSupported: () => Notification.isSupported(),
    show: (title, body, options) => new Notification({ title, body, silent: options?.silent }).show()
  }, {
    broadcast: (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('r1.reminderDue', event)
      }
    }
  }, () => new R1Preferences(db).get().doNotDisturb)
}
