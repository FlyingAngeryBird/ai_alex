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
  kind?: 'standard' | 'followup'
  recoveredCount?: number
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
  private lastTick: number | null = null

  constructor(private readonly db: R1Database,
    private readonly notifications: NotificationPort,
    private readonly windows: WindowPort, private readonly isQuiet: () => boolean = () => false) {
    this.items = new R1Items(db)
  }

  start(): void {
    if (this.timer) return
    this.recoverMissed()
    this.tick()
    this.timer = setInterval(() => this.tick(), 1000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  tick(now = new Date()): void {
    if (this.lastTick !== null && now.getTime() - this.lastTick > 5000) this.recoverMissed(now)
    this.lastTick = now.getTime()
    const due = this.db.prepare(`SELECT reminder_id, schedule_version, body, due_at_utc,kind
      FROM reminders WHERE status = 'scheduled' AND due_at_utc <= ?
      ORDER BY due_at_utc LIMIT 50`).all(now.toISOString()) as {
      reminder_id: string; schedule_version: number; body: string; due_at_utc: string; kind: 'standard' | 'followup'
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
        dueAtUtc: row.due_at_utc, systemRequested, silent, kind: row.kind })
    }
  }
  recoverMissed(now = new Date()): void {
    const rows = this.db.prepare("SELECT reminder_id,schedule_version,body,due_at_utc FROM reminders WHERE status='scheduled' AND due_at_utc<? ORDER BY due_at_utc")
      .all(new Date(now.getTime()-1000).toISOString()) as {reminder_id:string;schedule_version:number;body:string;due_at_utc:string}[]
    const recent: typeof rows = []
    for (const row of rows) {
      if (now.getTime()-Date.parse(row.due_at_utc)>24*3600*1000) this.items.markMissed(row.reminder_id,row.schedule_version)
      else if(this.items.deliver(row.reminder_id,row.schedule_version,'in_app').delivered) recent.push(row)
    }
    if (!recent.length) return
    const body=`有 ${recent.length} 条提醒在应用未能及时投递期间到期，请到事项中查看。`
    let systemRequested=false
    const silent=this.isQuiet()
    if(this.notifications.isSupported()) {
      const requested=recent.filter(row=>this.items.markSystemRequested(row.reminder_id,row.schedule_version))
      if(requested.length) {
        try { this.notifications.show('Seamo AI 错过的提醒',body,{silent});systemRequested=true }
        catch { for(const row of requested)this.items.markSystemRequestFailed(row.reminder_id,row.schedule_version) }
      }
    }
    this.windows.broadcast({reminderId:recent[0].reminder_id,body,dueAtUtc:recent[0].due_at_utc,systemRequested,silent,recoveredCount:recent.length})
  }
}

export function createElectronReminderScheduler(db: R1Database): ReminderScheduler {
  return new ReminderScheduler(db, {
    isSupported: () => Notification.isSupported(),
    show: (title, body, options) => new Notification({ title, body, silent: options?.silent }).show()
  }, {
    broadcast: (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        const send=()=>{if(!window.isDestroyed()&&!window.webContents.isDestroyed())window.webContents.send('r1.reminderDue',event)}
        if(window.webContents.isLoadingMainFrame())window.webContents.once('did-finish-load',send)
        else send()
      }
    }
  }, () => new R1Preferences(db).get().doNotDisturb)
}
