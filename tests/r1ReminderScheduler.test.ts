import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ Notification: class {}, BrowserWindow: class {} }))

import { openR1Database } from '../electron/main/r1/database'
import { R1Items } from '../electron/main/r1/items'
import { ReminderScheduler } from '../electron/main/r1/reminderScheduler'

describe('R1 reminder scheduler', () => {
  it('keeps quiet-mode reminders and their receipts while requesting a silent system notification', () => {
    const db = openR1Database(':memory:'), show = vi.fn(), broadcast = vi.fn()
    try {
      const due = new R1Items(db).createReminder({ actionId: 'quiet', linkPurpose: 'independent', body: '合成提醒', dueAtUtc: new Date(Date.now() + 1000).toISOString(), timezone: 'Asia/Shanghai' }).reminder
      const scheduler = new ReminderScheduler(db, { isSupported: () => true, show }, { broadcast }, () => true)
      vi.useFakeTimers(); vi.setSystemTime(new Date(Date.now() + 2000))
      scheduler.tick(); scheduler.tick()
      expect(show).toHaveBeenCalledExactlyOnceWith('Seamo AI 提醒', '合成提醒', { silent: true })
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ reminderId: due.reminderId, silent: true, systemRequested: true }))
      expect(db.prepare('SELECT COUNT(*) AS n FROM deliveries').get()).toMatchObject({ n: 1 })
    } finally { vi.useRealTimers(); db.close() }
  })
  it('records one in-app delivery and one system request per schedule version', () => {
    const db = openR1Database(':memory:')
    try {
      const items = new R1Items(db)
      const reminder = items.createReminder({ actionId: 'create', linkPurpose: 'independent',
        body: '喝水', dueAtUtc: new Date(Date.now() + 2000).toISOString(),
        timezone: 'Asia/Shanghai' }).reminder
      const show = vi.fn()
      const broadcast = vi.fn()
      const scheduler = new ReminderScheduler(db, { isSupported: () => true, show }, { broadcast })
      vi.useFakeTimers()
      vi.setSystemTime(new Date(Date.now() + 3000))
      scheduler.tick()
      scheduler.tick()
      expect(show).toHaveBeenCalledTimes(1)
      expect(broadcast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        reminderId: reminder.reminderId, systemRequested: true }))
      expect(db.prepare('SELECT channel FROM deliveries').all()).toEqual([{ channel: 'system' }])
    } finally { vi.useRealTimers(); db.close() }
  })

  it('keeps an in-app receipt when OS notifications are unavailable', () => {
    const db = openR1Database(':memory:')
    try {
      const items = new R1Items(db)
      items.createReminder({ actionId: 'create', linkPurpose: 'independent', body: '休息',
        dueAtUtc: new Date(Date.now() + 2000).toISOString(), timezone: 'Asia/Shanghai' })
      const broadcast = vi.fn()
      vi.useFakeTimers()
      vi.setSystemTime(new Date(Date.now() + 3000))
      new ReminderScheduler(db, { isSupported: () => false, show: vi.fn() }, { broadcast })
        .tick()
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ systemRequested: false }))
      expect(db.prepare('SELECT channel FROM deliveries').all()).toEqual([{ channel: 'in_app' }])
    } finally { vi.useRealTimers(); db.close() }
  })

  it('does not claim a system request when the native notification call fails', () => {
    const db = openR1Database(':memory:')
    try {
      new R1Items(db).createReminder({ actionId: 'create', linkPurpose: 'independent',
        body: '休息', dueAtUtc: new Date(Date.now() + 2000).toISOString(), timezone: 'Asia/Shanghai' })
      const broadcast = vi.fn()
      vi.useFakeTimers()
      vi.setSystemTime(new Date(Date.now() + 3000))
      new ReminderScheduler(db, { isSupported: () => true,
        show: () => { throw new Error('native failed') } }, { broadcast })
        .tick()
      expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ systemRequested: false }))
      expect(db.prepare('SELECT channel, status FROM deliveries').all())
        .toEqual([{ channel: 'in_app', status: 'system_failed' }])
    } finally { vi.useRealTimers(); db.close() }
  })

  it('does not notify for a reminder cancelled with its todo', () => {
    const db = openR1Database(':memory:')
    try {
      const items = new R1Items(db)
      const item = items.create({ actionId: 'item', kind: 'todo', title: '任务', body: '完成' }).item
      items.createReminder({ actionId: 'remind', itemId: item.itemId, linkPurpose: 'todo_due',
        body: '催办', dueAtUtc: new Date(Date.now() + 60_000).toISOString(), timezone: 'Asia/Shanghai' })
      items.complete({ actionId: 'complete', itemId: item.itemId, expectedVersion: 1, completed: true })
      const broadcast = vi.fn()
      new ReminderScheduler(db, { isSupported: () => true, show: vi.fn() }, { broadcast })
        .tick(new Date(Date.now() + 120_000))
      expect(broadcast).not.toHaveBeenCalled()
    } finally { db.close() }
  })
})

describe('R1 missed reminders after startup or wake',()=>{
 it('groups reminders missed within 24 hours once and silently lists older reminders',()=>{
  const db=openR1Database(':memory:'),show=vi.fn(),broadcast=vi.fn(),items=new R1Items(db)
  vi.useFakeTimers();const start=Date.now()
  try{
   const old=items.createReminder({actionId:'old',linkPurpose:'independent',body:'过期合成提醒',dueAtUtc:new Date(start+1000).toISOString(),timezone:'Asia/Shanghai'}).reminder
   const a=items.createReminder({actionId:'recent-a',linkPurpose:'independent',body:'近期一',dueAtUtc:new Date(start+25*3600000).toISOString(),timezone:'Asia/Shanghai'}).reminder
   const b=items.createReminder({actionId:'recent-b',linkPurpose:'independent',body:'近期二',dueAtUtc:new Date(start+26*3600000).toISOString(),timezone:'Asia/Shanghai'}).reminder
   vi.setSystemTime(start+27*3600000)
   const scheduler=new ReminderScheduler(db,{isSupported:()=>true,show},{broadcast},()=>true)
   scheduler.recoverMissed();scheduler.recoverMissed();scheduler.tick()
   expect(show).toHaveBeenCalledTimes(1)
   expect(broadcast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({recoveredCount:2,silent:true,systemRequested:true}))
   expect(items.listReminders().find(r=>r.reminderId===old.reminderId)).toMatchObject({status:'missed',deliveryStatus:'missed'})
   for(const id of [a.reminderId,b.reminderId])expect(items.listReminders().find(r=>r.reminderId===id)).toMatchObject({status:'due',deliveryStatus:'system_requested'})
   expect(db.prepare('SELECT COUNT(*) AS n FROM deliveries').get()).toMatchObject({n:3})
  }finally{vi.useRealTimers();db.close()}
 })
 it('emits a one-time followup with its kind and never replays a cancelled schedule',()=>{
  const db=openR1Database(':memory:'),items=new R1Items(db),broadcast=vi.fn()
  vi.useFakeTimers();const start=Date.now()
  try{
   items.createReminder({actionId:'followup',linkPurpose:'independent',kind:'followup',body:'合成回访',dueAtUtc:new Date(start+1000).toISOString(),timezone:'Asia/Shanghai'})
   const scheduler=new ReminderScheduler(db,{isSupported:()=>false,show:vi.fn()},{broadcast})
   vi.setSystemTime(start+1500);scheduler.tick();scheduler.tick()
   expect(broadcast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({kind:'followup'}))
  }finally{vi.useRealTimers();db.close()}
 })
})
