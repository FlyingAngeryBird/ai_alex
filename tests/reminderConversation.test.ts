import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1ConversationTools } from '../electron/main/r1/conversationTools'
import { R1Items } from '../electron/main/r1/items'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { validatedReminderTime } from '../electron/main/r1/reminderTime'
const assets = loadR1PromptAssets(resolve('r1-assets'))
afterEach(() => vi.useRealTimers())
function setup(body: string, temporary = false) {
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db)
  const source = conversations.append({ sessionId: conversations.start(temporary), turnId: 'actual-turn', role: 'user', body, status: 'final' })
  const tasks = new R1TaskSupervisor(db, assets, () => 0)
  const scope = { source, temporary, timezone: 'Asia/Shanghai', persistenceConfirmed: false, assertCurrent: () => undefined }
  const tools = new R1ConversationTools(db, assets, tasks, scope, [])
  tools.execute('load_skill', { skillId: 'SK04' }, 'skill')
  return { db, tasks, source, tools, items: new R1Items(db), scope }
}
it('creates, queries, reschedules and cancels the same reminder with actual receipts and versions', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-14T10:00:00Z'))
  const s = setup('明晚八点提醒去公园')
  try {
    const args = { content: '去公园', dueAt: '2026-10-15T20:00:00+08:00', timezone: 'Asia/Shanghai', kind: 'reminder',
      itemId: null, sourceRefs: [s.source.turnId], linkPurpose: 'independent' }
    const created = s.tools.execute('reminders_create', args, 'create')
    expect(created).toMatchObject({ status: 'succeeded', data: { reminder: { dueAt: '2026-10-15T12:00:00.000Z', scheduleVersion: 1, deliveryScope: 'app_running_and_awake' } } })
    expect(s.tools.execute('reminders_create', args, 'create')).toEqual(created)
    expect(s.items.listReminders()).toHaveLength(1)
    const id = created.entityId as string
    expect(s.tools.execute('reminders_list', { reminderIds: [id] }, 'read')).toMatchObject({ status: 'succeeded', data: { items: [{ reminderId: id, scheduleVersion: 1 }] } })
    const followup = new R1Conversations(s.db).append({ sessionId: s.source.sessionId, turnId: 'reschedule-turn', role: 'user', body: '改到后天晚上八点', status: 'final' })
    const nextTools = new R1ConversationTools(s.db, assets, s.tasks, { ...s.scope, source: followup }, [])
    nextTools.execute('load_skill', { skillId: 'SK04' }, 'load')
    nextTools.execute('reminders_list', { reminderIds: [id] }, 'read')
    const changed = nextTools.execute('reminders_reschedule', { reminderId: id, expectedVersion: 1, dueAt: '2026-10-16T20:00:00+08:00', timezone: 'Asia/Shanghai' }, 'reschedule')
    expect(changed).toMatchObject({ status: 'succeeded', entityId: id, entityVersion: 2 })
    expect(nextTools.execute('reminders_cancel', { reminderId: id, expectedVersion: 1 }, 'stale')).toMatchObject({ status: 'failed', errorCode: 'VERSION_CONFLICT' })
    expect(nextTools.execute('reminders_cancel', { reminderId: id, expectedVersion: 2 }, 'cancel')).toMatchObject({ status: 'succeeded', entityId: id, entityVersion: 3 })
    expect(s.items.listReminders()).toHaveLength(1)
  } finally { s.tasks.close(); s.db.close() }
})
it('rejects a guessed evening clock, mismatched relative date, invented object and temporary persistence', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-14T10:00:00Z'))
  const s = setup('明晚提醒去公园')
  const args = { content: '去公园', dueAt: '2026-10-15T20:00:00+08:00', timezone: 'Asia/Shanghai', kind: 'reminder', itemId: null, sourceRefs: [], linkPurpose: 'independent' }
  try {
    expect(s.tools.execute('reminders_create', args, 'vague')).toMatchObject({ status: 'failed', errorCode: 'REMINDER_TIME_CONFIRMATION_REQUIRED' })
    expect(s.tools.execute('reminders_cancel', { reminderId: 'invented', expectedVersion: 1 }, 'unknown')).toMatchObject({ status: 'failed', errorCode: 'REMINDER_NOT_OBSERVED' })
    expect(() => validatedReminderTime({ dueAt: '2026-10-16T20:00:00+08:00', timezone: 'Asia/Shanghai' }, { body: '明晚八点', createdAt: s.source.createdAt, timezone: 'Asia/Shanghai' })).toThrow('REMINDER_TIME_SOURCE_MISMATCH')
    expect(s.items.listReminders()).toEqual([])
  } finally { s.tasks.close(); s.db.close() }
  const temp = setup('明晚八点提醒去公园', true)
  try { expect(temp.tools.execute('reminders_create', args, 'temp')).toMatchObject({ status: 'failed', errorCode: 'TEMPORARY_SAVE_CONFIRMATION_REQUIRED' }); expect(temp.items.listReminders()).toEqual([]) }
  finally { temp.tasks.close(); temp.db.close() }
})
it('anchors relative minutes before midnight to the recorded source time, not a late tool execution', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-14T16:00:10Z'))
  expect(validatedReminderTime({ dueAt: '2026-10-15T00:05:00+08:00', timezone: 'Asia/Shanghai' },
    { body: '十分钟后提醒喝水', createdAt: '2026-10-14T15:55:00Z', timezone: 'Asia/Shanghai' })).toBe('2026-10-14T16:05:00.000Z')
  expect(() => validatedReminderTime({ dueAt: '2026-10-15T00:10:10+08:00', timezone: 'Asia/Shanghai' },
    { body: '十分钟后提醒喝水', createdAt: '2026-10-14T15:55:00Z', timezone: 'Asia/Shanghai' })).toThrow('REMINDER_TIME_SOURCE_MISMATCH')
})

it('keeps the original relative-day anchor when a cited clarification arrives after midnight', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-14T15:59:00Z'))
  const s = setup('明晚提醒去公园')
  try {
    vi.setSystemTime(new Date('2026-10-14T16:01:00Z'))
    const clarification = new R1Conversations(s.db).append({ sessionId: s.source.sessionId, turnId: 'clarification', role: 'user', body: '晚上八点', status: 'final' })
    const tools = new R1ConversationTools(s.db, assets, s.tasks, { ...s.scope, source: clarification, sourceMessages: [s.source, clarification] }, [])
    tools.execute('load_skill', { skillId: 'SK04' }, 'load')
    const args = { content: '去公园', dueAt: '2026-10-15T20:00:00+08:00', timezone: 'Asia/Shanghai', kind: 'reminder', itemId: null,
      sourceRefs: [s.source.turnId, clarification.turnId], linkPurpose: 'independent' }
    expect(tools.execute('reminders_create', args, 'valid')).toMatchObject({ status: 'succeeded' })
    expect(tools.execute('reminders_create', { ...args, dueAt: '2026-10-16T20:00:00+08:00' }, 'shifted')).toMatchObject({ status: 'failed', errorCode: 'REMINDER_TIME_SOURCE_MISMATCH' })
    expect(s.items.listReminders()).toHaveLength(1)
  } finally { s.tasks.close(); s.db.close() }
})
