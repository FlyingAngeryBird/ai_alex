import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1MemoryStore } from '../electron/main/r1/memory'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1MemoryConfirmations } from '../electron/main/r1/memoryConfirmations'
import { R1ConversationTools } from '../electron/main/r1/conversationTools'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { registerMemoryConfirmationHandlers } from '../electron/main/ipc/memoryConfirmationHandlers'
import { registerChatHandlers } from '../electron/main/ipc/chatHandlers'
import { R1PersonaStore } from '../electron/main/r1/persona'
import { R1ConversationDriver } from '../electron/main/r1/conversationDriver'
import { createArkResponsesProvider } from '../electron/main/providers/arkResponsesProvider'
vi.mock('electron', () => ({ ipcMain: { handle() {} } }))
const assets = loadR1PromptAssets(resolve('r1-assets'))
function setup(temporary = false, body = '记住，我对花生过敏。') {
  const db = openR1Database(':memory:'), memory = new R1MemoryStore(db), conversations = new R1Conversations(db)
  const sessionId = conversations.start(temporary)
  const source = conversations.append({ sessionId, turnId: 'actual-user-turn', role: 'user', body, status: 'final' })
  const tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch())
  let current = true, now = Date.now(), mode = temporary, epoch = memory.currentDeletionEpoch()
  const notify = vi.fn(), invalidated = vi.fn(), exited = vi.fn()
  const manager = new R1MemoryConfirmations(db, { notify, onInvalidated: invalidated, onTemporaryExited: exited, now: () => now })
  manager.bindTemporaryExit(() => { conversations.end(sessionId); mode = false })
  const scope = { source, temporary, timezone: 'Asia/Shanghai', persistenceConfirmed: false,
    assertCurrent() { if (!current || epoch !== memory.currentDeletionEpoch() || mode !== temporary) throw new Error('CONTEXT_CHANGED') },
    onMemoryInvalidated(next: number) { epoch = next },
    requestMemoryConfirmation: (candidate: Parameters<R1MemoryConfirmations['offer']>[0], sensitive: boolean) => manager.offer(candidate, {
      source, temporary, sensitive, ownerId: 7, assertCurrent: scope.assertCurrent }) }
  const tools = new R1ConversationTools(db, assets, tasks, scope, [])
  return { db, memory, conversations, source, manager, tools, notify, invalidated, exited, mode: () => mode,
    stale: () => { current = false }, advance: () => { now += 300_001 }, close() { tasks.close(); db.close() } }
}
function propose(s: ReturnType<typeof setup>, content = '对花生过敏') {
  const output = s.tools.execute('memory_remember', { content, category: 'profile', sourceRefs: [s.source.turnId] }, 'propose')
  expect(output).toMatchObject({ kind: 'ui_action', action: 'confirm_memory', status: 'awaiting_user' })
  return output.uiActionId as string
}
describe('memory candidate confirmation authority', () => {
  it('rejects invalid candidates before showing a confirmation or creating a source', () => {
    const s = setup()
    try {
      const context = { ownerId: 7, source: s.source, temporary: false, sensitive: true, assertCurrent() {} }
      expect(() => s.manager.offer({ operation: 'remember', content: ' ', category: 'profile', validUntil: null }, context)).toThrow('INVALID_MEMORY_CONTENT')
      expect(() => s.manager.offer({ operation: 'remember', content: '对花生过敏', category: 'profile', validUntil: '2099-02-30T00:00:00Z' }, context)).toThrow('INVALID_EXPIRY')
      expect(s.notify).not.toHaveBeenCalled()
      expect(s.memory.list().entries).toEqual([])
    } finally { s.close() }
  })
  it.each([false, true])('exits the actual temporary session and clears its messages even when cleanup notification fails (%s)', async (failNotification) => {
    const db = openR1Database(':memory:'), memory = new R1MemoryStore(db), conversations = new R1Conversations(db), persona = new R1PersonaStore(db)
    const tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch()), mode = { temporary: false, sessionId: null as string | null }
    const notify = vi.fn(), exited = vi.fn(), manager = new R1MemoryConfirmations(db, { notify, onInvalidated() {}, onTemporaryExited: exited })
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
    let decision = 0
    const ark = createArkResponsesProvider({ env: { VOLCENGINE_ARK_API_KEY: 'synthetic', VOLCENGINE_ARK_MODEL: 'synthetic' }, fetch: async () => {
      decision++
      return new Response(JSON.stringify({ id: `response-${decision}`, status: 'completed', output: decision === 1 ? [{
        type: 'function_call', call_id: 'pending', name: 'memory_remember', arguments: JSON.stringify({ content: '喜欢无糖茶', category: 'preference', sourceRefs: [] })
      }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好。' }] }] }))
    } })
    try {
      const driver = new R1ConversationDriver(db, assets, tasks, ark, () => persona.get(), [])
      registerChatHandlers({ handle(name, handler) { handlers.set(name, handler) } }, undefined, undefined, conversations, persona, assets, memory, mode,
        (id, temporary) => { manager.revokeAll(); if (temporary) { tasks.endTemporary(id); if (failNotification) throw new Error('NOTIFICATION_FAILED') } }, driver, undefined, manager)
      handlers.get('chat.setTemporary')!(null, { enabled: true })
      const temporaryId = mode.sessionId!
      expect(await handlers.get('chat.sendMessage')!({ sender: { id: 7 } }, { text: '记住，我喜欢无糖茶。另有临时私密内容。' })).toMatchObject({ ok: true, data: { reply: expect.stringContaining('还没有保存') } })
      expect(memory.list().entries).toEqual([])
      expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toMatchObject({ n: 0 })
      const pending = notify.mock.calls.find(call => call[1]?.confirmationId)![1]
      expect(manager.commit(7, pending.confirmationId)).toMatchObject({ sessionChanged: true })
      expect(exited).toHaveBeenCalledOnce()
      expect(mode.temporary).toBe(false); expect(mode.sessionId).not.toBe(temporaryId)
      expect(() => conversations.messages(temporaryId)).toThrow('SESSION_NOT_FOUND')
      expect(await handlers.get('chat.sendMessage')!({ sender: { id: 7 } }, { text: '你好' })).toMatchObject({ ok: true })
      expect(conversations.messages(mode.sessionId!)).toMatchObject([{ body: '你好', role: 'user' }, { body: '你好。', role: 'assistant' }])
      expect(JSON.stringify(db.prepare('SELECT body FROM messages').all())).not.toContain('私密内容')
    } finally { tasks.close(); db.close() }
  })
  it('keeps sensitive candidates in memory and commits only the exact candidate for the originating window, once', () => {
    const s = setup()
    try {
      const id = propose(s)
      expect(s.memory.list().entries).toEqual([])
      expect(s.notify.mock.calls[0]).toMatchObject([7, { confirmationId: id, content: '对花生过敏', sensitive: true, temporary: false }])
      expect(() => s.manager.commit(8, id)).toThrow('MEMORY_CONFIRMATION_NOT_FOUND')
      const committed = s.manager.commit(7, id)
      expect(committed).toMatchObject({ temporary: false, sessionChanged: false, memory: { content: '对花生过敏', version: 1, sourceRefs: [s.source.messageId] } })
      expect(s.manager.commit(7, id)).toEqual(committed)
      expect(s.memory.list().entries).toHaveLength(1)
      expect(JSON.stringify(s.db.prepare('SELECT payload_json FROM event_log').all())).not.toContain('花生')
    } finally { s.close() }
  })
  it('cancels without a write, rejects the cancelled source proposal, and expires or revokes old contexts', () => {
    const s = setup()
    try {
      const id = propose(s)
      s.manager.cancel(7, id)
      expect(() => s.manager.commit(7, id)).toThrow('MEMORY_CONFIRMATION_NOT_FOUND')
      expect(s.tools.execute('memory_remember', { content: '对花生过敏', category: 'profile', sourceRefs: [] }, 'repeat')).toMatchObject({ status: 'failed', errorCode: 'MEMORY_CONFIRMATION_CANCELLED' })
      expect(s.memory.list().entries).toEqual([])
    } finally { s.close() }
    for (const action of ['expire', 'stale'] as const) {
      const fresh = setup()
      try {
        const id = propose(fresh)
        if (action === 'expire') fresh.advance(); else fresh.stale()
        expect(() => fresh.manager.commit(7, id)).toThrow(action === 'expire' ? 'MEMORY_CONFIRMATION_EXPIRED' : 'MEMORY_CONFIRMATION_STALE')
        expect(fresh.memory.list().entries).toEqual([])
      } finally { fresh.close() }
    }
  })
  it('preserves temporary mode on cancel and persists only confirmed content on successful exit, without copying temporary chat', () => {
    const cancelled = setup(true, '记住，我喜欢無糖茶。')
    try { const id = propose(cancelled, '喜欢無糖茶'); cancelled.manager.cancel(7, id); expect(cancelled.mode()).toBe(true); expect(cancelled.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toMatchObject({ n: 0 }) } finally { cancelled.close() }
    const s = setup(true, '记住，我喜欢无糖茶。这里还有另一段临时隐私。')
    try {
      expect(() => s.tools.execute('memory_recall', { query: '茶' }, 'read')).toThrow('MODEL_TOOL_NOT_EXPOSED')
      const id = propose(s, '喜欢无糖茶')
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toMatchObject({ n: 0 })
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM memory').get()).toMatchObject({ n: 0 })
      const result = s.manager.commit(7, id)
      expect(result).toMatchObject({ temporary: false, sessionChanged: true, memory: { content: '喜欢无糖茶' } })
      expect(s.mode()).toBe(false); expect(s.exited).toHaveBeenCalledOnce()
      expect(s.memory.sources(result.memory.memoryId)).toMatchObject([{ body: '喜欢无糖茶' }])
      expect(JSON.stringify(s.db.prepare('SELECT body FROM messages').all())).not.toContain('临时隐私')
      expect(() => s.conversations.messages(s.source.sessionId)).toThrow('SESSION_NOT_FOUND')
      expect(s.manager.commit(7, id)).toEqual(result)
    } finally { s.close() }
  })
  it('checks sensitive corrections again at confirmation and preserves both original and correcting sources', () => {
    const s = setup(false, '更正关于过敏的记忆，我对牛奶过敏。')
    try {
      const original = s.memory.addManual({ content: '对花生过敏', category: 'profile' })
      s.tools.execute('memory_recall', { query: '过敏' }, 'read')
      const output = s.tools.execute('memory_update', { memoryId: original.memoryId, expectedVersion: 1, content: '对牛奶过敏' }, 'update')
      expect(output).toMatchObject({ kind: 'ui_action', status: 'awaiting_user' })
      expect(s.memory.recall('花生')).toHaveLength(1)
      const result = s.manager.commit(7, output.uiActionId as string)
      expect(result.memory).toMatchObject({ version: 2, content: '对牛奶过敏', sourceRefs: [...original.sourceRefs, s.source.messageId] })
      expect(s.invalidated).toHaveBeenCalledWith(1)
      expect(s.conversations.modelTurns(s.source.sessionId)).toEqual([])
    } finally { s.close() }
  })
  it('does not commit a replaced source or a newer target version', () => {
    const s = setup()
    try {
      const id = propose(s)
      s.db.prepare('UPDATE messages SET body = ? WHERE message_id = ?').run('已经更改的来源', s.source.messageId)
      expect(() => s.manager.commit(7, id)).toThrow('MEMORY_SOURCE_NOT_AVAILABLE')
      expect(s.memory.list().entries).toEqual([])
    } finally { s.close() }
    const correction = setup(false, '更正记忆，我对牛奶过敏。')
    try {
      const old = correction.memory.addManual({ content: '花生过敏', category: 'profile' })
      correction.tools.execute('memory_recall', { query: '过敏' }, 'read')
      const output = correction.tools.execute('memory_update', { memoryId: old.memoryId, expectedVersion: 1, content: '牛奶过敏' }, 'pending')
      correction.db.prepare('UPDATE memory SET version = 2 WHERE memory_id = ?').run(old.memoryId)
      expect(() => correction.manager.commit(7, output.uiActionId as string)).toThrow('VERSION_CONFLICT')
      expect(correction.memory.recall('花生')[0].content).toBe('花生过敏')
    } finally { correction.close() }
  })
  it('accepts only opaque confirmation IDs over IPC, not caller-supplied content or authorization flags', () => {
    const s = setup()
    try {
      const id = propose(s), handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
      registerMemoryConfirmationHandlers(s.manager, { handle(name, handler) { handlers.set(name, handler) } })
      const commit = handlers.get('r1.memory.confirmSave')!
      expect(commit({ sender: { id: 7 } }, { confirmationId: id, content: 'different', confirmed: true })).toMatchObject({ ok: false, error: { code: 'INVALID_MEMORY_CONFIRMATION' } })
      expect(commit({ sender: { id: 8 } }, { confirmationId: id })).toMatchObject({ ok: false, error: { code: 'MEMORY_CONFIRMATION_NOT_FOUND' } })
      expect(s.memory.list().entries).toEqual([])
      expect(commit({ sender: { id: 7 } }, { confirmationId: id })).toMatchObject({ ok: true, data: { memory: { content: '对花生过敏' } } })
    } finally { s.close() }
  })
})
