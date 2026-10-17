import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { openR1Database, inTransaction } from '../electron/main/r1/database'
import { R1Focus } from '../electron/main/r1/focus'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1ConversationTools } from '../electron/main/r1/conversationTools'
import { R1TaskToolExecutor } from '../electron/main/r1/taskToolExecutor'
import { R1Items } from '../electron/main/r1/items'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
const assets = loadR1PromptAssets(resolve('r1-assets'))
function setup(body = '开始25分钟专注') {
  const db = openR1Database(':memory:'), focus = new R1Focus(db, () => 0), conversations = new R1Conversations(db)
  const source = conversations.append({ sessionId: conversations.start(), turnId: 'source', role: 'user', body, status: 'final' })
  const tasks = new R1TaskSupervisor(db, assets, () => 0)
  let track = 'netease:one'
  const services = { focus, currentTrackKey: () => track }
  const tools = new R1ConversationTools(db, assets, tasks, { source, temporary: false, timezone: 'Asia/Shanghai', persistenceConfirmed: false, assertCurrent() {} }, [], services)
  tools.execute('load_skill', { skillId: 'SK04' }, 'skill')
  return { db, focus, source, tasks, tools, services, changeTrack: () => { track = 'kuwo:two' } }
}
it('uses the shared focus service, refuses replacement and controls the same focus by observed version', () => {
  const s = setup()
  try {
    const started = s.tools.execute('focus_start', { durationSec: 1500, endMusicRule: 'none' }, 'start')
    expect(started).toMatchObject({ status: 'succeeded', data: { focus: { state: 'running', endMusicRule: 'none' } } })
    const id = started.entityId as string
    expect(s.tools.execute('focus_start', { durationSec: 1500, endMusicRule: 'none' }, 'start')).toEqual(started)
    expect(s.tools.execute('focus_start', { durationSec: 600, endMusicRule: 'none' }, 'replace')).toMatchObject({ status: 'failed', errorCode: 'FOCUS_ALREADY_ACTIVE' })
    expect(s.tools.execute('focus_pause', { focusId: id, expectedVersion: 1 }, 'pause')).toMatchObject({ status: 'succeeded', entityVersion: 2 })
    expect(s.tools.execute('focus_resume', { focusId: id, expectedVersion: 1 }, 'stale')).toMatchObject({ status: 'failed', errorCode: 'VERSION_CONFLICT' })
    expect(s.tools.execute('focus_resume', { focusId: id, expectedVersion: 2 }, 'resume')).toMatchObject({ status: 'succeeded', entityVersion: 3 })
    expect(s.tools.execute('focus_stop', { focusId: id, expectedVersion: 3 }, 'stop')).toMatchObject({ status: 'succeeded', entityVersion: 4 })
    expect(s.focus.getState()?.state).toBe('stopped')
  } finally { s.tasks.close(); s.focus.close(); s.db.close() }
})
it('binds an explicit end-music agreement to the track selected at the user turn, never a later song', () => {
  const s = setup('开始25分钟专注，专注结束后暂停当前音乐')
  try {
    s.changeTrack()
    const started = s.tools.execute('focus_start', { durationSec: 1500, endMusicRule: 'pause_user_selected_track' }, 'start')
    expect(started).toMatchObject({ status: 'succeeded', data: { focus: { endTargetTrackKey: 'netease:one' } } })
  } finally { s.tasks.close(); s.focus.close(); s.db.close() }
  const noAgreement = setup()
  try { expect(noAgreement.tools.execute('focus_start', { durationSec: 1500, endMusicRule: 'pause_user_selected_track' }, 'start')).toMatchObject({ status: 'failed', errorCode: 'FOCUS_MUSIC_CONFIRMATION_REQUIRED' }) }
  finally { noAgreement.tasks.close(); noAgreement.focus.close(); noAgreement.db.close() }
})
it('rolls back focus state, clock anchor and notifications when the outer tool transaction fails', () => {
  const s = setup(), events: string[] = []
  s.focus.onChanged(event => { expect(s.db.isTransaction).toBe(false); events.push(event.reason) })
  try {
    expect(() => inTransaction(s.db, () => {
      s.focus.start({ actionId: 'rolled-back', durationSec: 60, endMusicRule: 'none' })
      expect(events).toEqual([])
      throw new Error('receipt-invalid')
    })).toThrow('receipt-invalid')
    expect(s.focus.getState()).toBeNull(); expect(events).toEqual([])
    inTransaction(s.db, () => {
      s.focus.start({ actionId: 'actual', durationSec: 60, endMusicRule: 'none' })
      expect(events).toEqual([])
    })
    expect(events).toEqual(['started'])
  } finally { s.tasks.close(); s.focus.close(); s.db.close() }
})
it('lets an authorized background task use the same focus and records its committed receipt', () => {
  const s = setup()
  try {
    s.tasks.accept({ requestKey: 'focus-task', sourceMessageId: s.source.messageId, timezone: 'Asia/Shanghai', goal: '开始专注', constraints: [],
      complexity: 'complex', authorizedAliases: ['read_file', 'focus_start', 'focus_get_state'], requiredActions: [{ alias: 'focus_start', minimumCount: 1 }] })
    const active = s.tasks.claimNext()!
    const executor = new R1TaskToolExecutor(s.tasks, assets, new R1Items(s.db), undefined, undefined, s.services)
    executor.execute(active.lease, 'read_file', { file_path: '/skills/reminder-focus/SKILL.md' })
    const result = executor.execute(active.lease, 'focus_start', { durationSec: 1500, endMusicRule: 'none' }, 'start')
    expect(result.status).toBe('succeeded')
    expect(s.focus.getState()?.focusId).toBe(result.entityId)
    expect(s.tasks.readReceipt(active.lease, result.actionId)).toEqual(result)
  } finally { s.tasks.close(); s.focus.close(); s.db.close() }
})

it('keeps the already-running timer and suppresses events when a task receipt fails validation', () => {
  const s = setup(), events: string[] = []
  try {
    const started = s.focus.start({ actionId: 'initial', durationSec: 1500, endMusicRule: 'none' })
    s.focus.onChanged(event => events.push(event.reason))
    expect(() => inTransaction(s.db, () => {
      s.focus.pause({ actionId: 'bad-pause', focusId: started.focus.focusId, expectedVersion: 1 })
      throw new Error('bad-output')
    })).toThrow('bad-output')
    expect(s.db.prepare('SELECT state, version FROM focus WHERE focus_id = ?').get(started.focus.focusId)).toMatchObject({ state: 'running', version: 1 })
    expect(events).toEqual([])
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE action_id = ?').get('bad-pause')).toMatchObject({ n: 0 })
    expect(s.focus.getState()).toMatchObject({ state: 'running', version: 1 })
  } finally { s.tasks.close(); s.focus.close(); s.db.close() }
})
