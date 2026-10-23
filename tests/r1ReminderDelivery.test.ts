import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ Notification: class {}, BrowserWindow: class {} }))
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1Items } from '../electron/main/r1/items'
import { R1Focus } from '../electron/main/r1/focus'
import { R1ReminderDelivery } from '../electron/main/r1/reminderDelivery'
import { ReminderScheduler, type ReminderDueEvent } from '../electron/main/r1/reminderScheduler'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'

const assets = loadR1PromptAssets(resolve('r1-assets')), cleanups: Array<() => void> = []
function wave(): ArrayBuffer {
  const b = Buffer.alloc(48044); b.write('RIFF'); b.writeUInt32LE(48036, 4); b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24)
  b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(48000, 40)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}
function fixture() {
  for (const field of ['VOLCENGINE_REALTIME_API_KEY', 'VOLCENGINE_ARK_API_KEY', 'VOLCENGINE_ARK_MODEL']) vi.stubEnv(field, 'synthetic')
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db), items = new R1Items(db)
  const scope = { temporary: false, sessionId: conversations.start() }
  const preferences = { version: 1, doNotDisturb: false, proactiveSpeechEnabled: true, inputDeviceId: null, outputDeviceId: null, reducedMotion: false }
  const persona = { version: 1, assistantName: 'Seamo AI', userAddress: '海', style: '简短自然', voiceId: 'voice' }
  const configuration = { revision: 1 }, inputs: any[] = []
  const provider = { request: vi.fn(async (input: any) => {
    inputs.push(input)
    const prepared = input.boundary.finalize([{ role: 'system', content: 'unregistered' }])
    expect(prepared.tools).toEqual([]); expect(input.boundary.systemText).not.toContain('unregistered')
    expect(input.boundary.systemText).toContain('"assistantName":"Seamo AI"')
    expect(() => input.boundary.validateToolCall('reminders_create', {})).toThrow('NOTICE_TOOLS_FORBIDDEN')
    return { id: 'synthetic', text: '到约定的时间了，可以休息一下。', output: [], calls: [], usage: null }
  }) }
  const synthesize = vi.fn(async (input: any) => { input.boundary.assertCurrent(); expect(input.boundary.diagnostic.toolAliases).toEqual([]); return wave() })
  const service = new R1ReminderDelivery({ db, assets, conversations, scope: () => scope, preferences: () => preferences,
    persona: () => persona, configurationRevision: () => configuration.revision, provider, synthesize })
  const due = (kind: 'standard' | 'followup' = 'standard') => {
    const reminder = items.createReminder({ actionId: crypto.randomUUID(), linkPurpose: 'independent', kind,
      body: '合成验收提醒', dueAtUtc: new Date(Date.now() + 1000).toISOString(), timezone: 'Asia/Shanghai' }).reminder
    vi.useFakeTimers(); vi.setSystemTime(new Date(Date.now() + 2000))
    const events: ReminderDueEvent[] = []
    const scheduler = new ReminderScheduler(db, { isSupported: () => false, show: vi.fn() }, { broadcast: event => events.push(event) })
    scheduler.tick(); scheduler.tick()
    expect(events).toHaveLength(1)
    return { reminder, event: events[0], scheduler }
  }
  cleanups.push(() => { service.invalidate(); db.close() })
  return { db, items, conversations, scope, preferences, persona, provider, synthesize, service, due, configuration, inputs }
}
afterEach(() => { while (cleanups.length) cleanups.pop()!(); vi.useRealTimers(); vi.unstubAllEnvs() })
it('uses PR09 only for an actual scheduler delivery and never reschedules or duplicates it', async () => {
  const f = fixture(), { event } = f.due(), deliveryId = f.service.observeReminder(event)!
  expect(f.service.observeReminder(event)).toBeNull()
  const audio = await f.service.prepare(1, { deliveryId, requestId: 'request' })
  expect(audio?.responseId).toMatch(/^reminder-delivery:/)
  expect(f.inputs[0].boundary.systemText).toContain('"deliveryKind":"on_time"')
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM reminders').get()).toMatchObject({ n: 1 })
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get()).toMatchObject({ n: 1 })
  expect(await f.service.prepare(1, { deliveryId, requestId: 'repeat' })).toBeNull()
  expect(f.provider.request).toHaveBeenCalledTimes(1)
})
it.each(['doNotDisturb', 'proactiveSpeechEnabled', 'temporary'])('does not call PR09 when blocked by %s and never replays on unmute', async flag => {
  const f = fixture(), { event } = f.due()
  if (flag === 'doNotDisturb') f.preferences.doNotDisturb = true
  if (flag === 'proactiveSpeechEnabled') f.preferences.proactiveSpeechEnabled = false
  if (flag === 'temporary') f.scope.temporary = true
  const deliveryId = f.service.observeReminder(event)!
  f.preferences.doNotDisturb = false; f.preferences.proactiveSpeechEnabled = true; f.scope.temporary = false
  expect(await f.service.prepare(1, { deliveryId, requestId: 'request' })).toBeNull()
  expect(f.provider.request).not.toHaveBeenCalled()
  expect(f.items.listReminders()[0].status).toBe('due')
})
it('rejects forged, undelivered or rescheduled reminder events before model access', async () => {
  const f = fixture(), { reminder, event } = f.due()
  expect(f.service.observeReminder({ ...event, reminderId: 'unknown' })).toBeNull()
  const deliveryId = f.service.observeReminder(event)!
  f.items.reschedule({ actionId: 'reschedule', reminderId: reminder.reminderId, expectedScheduleVersion: 1,
    dueAtUtc: new Date(Date.now() + 60000).toISOString(), timezone: 'Asia/Shanghai' })
  await expect(f.service.prepare(1, { deliveryId, requestId: 'request' })).rejects.toThrow('NOTICE_REVOKED')
  expect(f.provider.request).not.toHaveBeenCalled()
})
it('distinguishes a once-only followup from an ordinary reminder', async () => {
  const f = fixture(), { event } = f.due('followup'), deliveryId = f.service.observeReminder(event)!
  await f.service.prepare(1, { deliveryId, requestId: 'request' })
  expect(f.inputs[0].boundary.systemText).toContain('"deliveryKind":"follow_up"')
  expect(f.items.listReminders()).toHaveLength(1)
})
it('uses one aggregate missed event and does not repeat each missed reminder aloud', async () => {
  const f = fixture(), start = Date.now()
  for (let i = 0; i < 2; i++) f.items.createReminder({ actionId: `missed-${i}`, linkPurpose: 'independent', body: '合成错过提醒',
    dueAtUtc: new Date(start + 1000 + i * 1000).toISOString(), timezone: 'Asia/Shanghai' })
  vi.useFakeTimers(); vi.setSystemTime(new Date(start + 3600000))
  const events: ReminderDueEvent[] = []
  const scheduler = new ReminderScheduler(f.db, { isSupported: () => false, show: vi.fn() }, { broadcast: event => events.push(event) })
  scheduler.recoverMissed(); scheduler.recoverMissed(); expect(events).toHaveLength(1)
  const deliveryId = f.service.observeReminder(events[0])!
  await f.service.prepare(1, { deliveryId, requestId: 'request' })
  expect(f.inputs[0].boundary.systemText).toContain('"deliveryKind":"missed"')
  expect(f.inputs[0].boundary.systemText).toContain('2 条提醒')
  expect(f.provider.request).toHaveBeenCalledTimes(1)
})
it('announces completed focus duration from actual state, never pause or stop', async () => {
  const f = fixture(); let clock = 0
  const focus = new R1Focus(f.db, () => clock), events: any[] = []
  focus.onChanged(event => events.push(event))
  const started = focus.start({ actionId: 'focus', durationSec: 60, endMusicRule: 'none' }).focus
  expect(f.service.observeFocus(events.at(-1))).toBeNull()
  clock = 60000; focus.tick()
  const event = events.at(-1), deliveryId = f.service.observeFocus(event)!
  expect(event.focus.focusId).toBe(started.focusId)
  expect(f.service.observeFocus(event)).toBeNull()
  await f.service.prepare(1, { deliveryId, requestId: 'request' })
  expect(f.inputs[0].boundary.systemText).toContain('"actualFocusDurationSec":60')
  expect(f.inputs[0].boundary.systemText).toContain('"deliveryKind":"focus_completed"')
  focus.close()
})
it('records actual heard progress and ignores a late completion after interruption', async () => {
  const f = fixture(), { event } = f.due(), deliveryId = f.service.observeReminder(event)!
  await f.service.prepare(1, { deliveryId, requestId: 'request' })
  expect(f.conversations.modelTurns(f.scope.sessionId)[0].text).toBe('')
  expect(() => f.service.reportPlayback(2, { requestId: 'request', status: 'started', playedUntilMs: 0 })).toThrow('NOTICE_OWNER_MISMATCH')
  f.service.reportPlayback(1, { requestId: 'request', status: 'started', playedUntilMs: 0 })
  f.service.reportPlayback(1, { requestId: 'request', status: 'interrupted', playedUntilMs: 400 })
  f.service.reportPlayback(1, { requestId: 'request', status: 'completed', playedUntilMs: 1000 })
  expect(f.conversations.messages(f.scope.sessionId)[0]).toMatchObject({ status: 'interrupted', playedUntilMs: 400 })
  expect(f.items.listReminders()[0].status).toBe('due')
})
it.each(['configuration', 'policy', 'session', 'invalidate'])('revokes a pending model result after %s changes', async kind => {
  const f = fixture(), { event } = f.due(), deliveryId = f.service.observeReminder(event)!
  let finish!: (value: any) => void
  f.provider.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = f.service.prepare(1, { deliveryId, requestId: 'request' })
  if (kind === 'configuration') f.configuration.revision++
  if (kind === 'policy') f.preferences.version++
  if (kind === 'session') f.scope.sessionId = f.conversations.start()
  if (kind === 'invalidate') f.service.invalidate()
  finish({ text: '过时事件' }); await expect(pending).rejects.toThrow('NOTICE_REVOKED')
  expect(f.synthesize).not.toHaveBeenCalled()
})
