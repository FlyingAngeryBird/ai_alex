import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle() {} }, dialog: {} }))
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1ConversationTools } from '../electron/main/r1/conversationTools'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { registerR1Handlers } from '../electron/main/ipc/r1Handlers'
import { temporaryPersistenceAllowed, type R1SessionMode } from '../electron/main/r1/sessionMode'

const assets = loadR1PromptAssets(resolve('r1-assets'))
type Handler = (event: unknown, payload?: unknown) => unknown

it('stores the trusted temporary-save acknowledgement in session mode, not in the model', () => {
  const db = openR1Database(':memory:')
  try {
    const handlers = new Map<string, Handler>()
    const mode: R1SessionMode = { temporary: true, sessionId: 'temporary-session' }
    registerR1Handlers(db, { handle: (channel, handler) => { handlers.set(channel, handler as Handler) } }, mode)
    const call = (payload?: unknown) => handlers.get('r1.session.temporaryPersistence')!({}, payload) as {
      ok: boolean; data?: { confirmed: boolean }; error?: { code: string } }
    expect(temporaryPersistenceAllowed(mode)).toBe(false)
    expect(call()).toMatchObject({ ok: true, data: { confirmed: false } })
    expect(call({ confirmed: true })).toMatchObject({ ok: true, data: { confirmed: true } })
    expect(temporaryPersistenceAllowed(mode)).toBe(true)
    expect(call({ confirmed: false })).toMatchObject({ ok: true, data: { confirmed: false } })
    expect(call({ confirmed: 'yes' })).toMatchObject({ ok: false, error: { code: 'INVALID_TEMPORARY_PERSISTENCE' } })
    mode.temporary = false
    expect(temporaryPersistenceAllowed(mode)).toBe(false)
  } finally { db.close() }
})

it('allows an explicit temporary save only after the acknowledgement, and still keeps the message temporary', () => {
  const db = openR1Database(':memory:')
  const conversations = new R1Conversations(db)
  const tasks = new R1TaskSupervisor(db, assets, () => 0)
  try {
    const sessionId = conversations.start(true)
    const source = conversations.append({ sessionId, turnId: 'turn-temp', role: 'user', status: 'final',
      body: '把这件事记下来，1小时后提醒我。' })
    const blocked = new R1ConversationTools(db, assets, tasks, { source, temporary: true, timezone: 'Asia/Shanghai',
      persistenceConfirmed: false, assertCurrent() {} }, [])
    blocked.execute('load_skill', { skillId: 'SK03' }, 'load-blocked')
    expect(blocked.execute('notes_create', { type: 'note', mode: 'original', title: '临时事项', content: '内容',
      sourceRefs: [source.messageId] }, 'save-blocked')).toMatchObject({ errorCode: 'TEMPORARY_SAVE_CONFIRMATION_REQUIRED' })

    const allowed = new R1ConversationTools(db, assets, tasks, { source, temporary: true, timezone: 'Asia/Shanghai',
      persistenceConfirmed: true, assertCurrent() {} }, [])
    allowed.execute('load_skill', { skillId: 'SK03' }, 'load-allowed')
    const saved = allowed.execute('notes_create', { type: 'note', mode: 'original', title: '临时事项', content: '内容',
      sourceRefs: [source.messageId] }, 'save-allowed')
    expect(saved).toMatchObject({ status: 'succeeded' })
    allowed.execute('load_skill', { skillId: 'SK04' }, 'load-reminder')
    const dueAt = new Date(Date.parse(source.createdAt) + 3600_000).toISOString()
    expect(allowed.execute('reminders_create', { content: '提醒我', dueAt, timezone: 'Asia/Shanghai', kind: 'reminder',
      itemId: (saved as { entityId: string }).entityId, sourceRefs: [source.turnId], linkPurpose: 'independent' }, 'remind'))
      .toMatchObject({ status: 'succeeded' })
    // The temporary message itself never enters the normal message table.
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toMatchObject({ n: 0 })
  } finally { tasks.close(); db.close() }
})
