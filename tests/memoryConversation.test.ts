import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openR1Database, inTransaction } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1MemoryStore } from '../electron/main/r1/memory'
import { R1ConversationTools } from '../electron/main/r1/conversationTools'
import { R1ConversationDriver } from '../electron/main/r1/conversationDriver'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { createArkResponsesProvider } from '../electron/main/providers/arkResponsesProvider'

const assets = loadR1PromptAssets(resolve('r1-assets'))
function setup() {
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db), memory = new R1MemoryStore(db)
  const sessionId = conversations.start(), tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch())
  const invalidated = vi.fn()
  function turn(text: string) {
    const source = conversations.append({ sessionId, turnId: crypto.randomUUID(), role: 'user', body: text, status: 'final' })
    let epoch = memory.currentDeletionEpoch()
    const scope = { source, temporary: false, timezone: 'Asia/Shanghai', persistenceConfirmed: false,
      assertCurrent() { if (epoch !== memory.currentDeletionEpoch()) throw new Error('SESSION_CHANGED') },
      onMemoryInvalidated(next: number) { epoch = next; tasks.invalidateContext(); invalidated(next) } }
    return { source, scope, tools: new R1ConversationTools(db, assets, tasks, scope, []) }
  }
  return { db, conversations, memory, sessionId, tasks, turn, invalidated, close() { tasks.close(); db.close() } }
}

describe('explicit memory conversation commits and revocation', () => {
  it('binds to the actual user source, merges repeated facts, and acknowledges only committed writes', () => {
    const s = setup()
    try {
      const { source, tools } = s.turn('请记住，我喜欢无糖茶。')
      const args = { content: '喜欢无糖茶', category: 'preference', sourceRefs: [source.turnId] }
      const saved = tools.execute('memory_remember', args, 'remember')
      expect(saved).toMatchObject({ status: 'succeeded', data: { merged: false, memory: { version: 1, sourceRefs: [source.messageId] } } })
      expect(tools.execute('memory_remember', args, 'remember')).toEqual(saved)
      expect(tools.execute('memory_remember', { ...args, sourceRefs: ['invented'] }, 'bad')).toMatchObject({ status: 'failed', errorCode: 'MEMORY_SOURCE_NOT_AVAILABLE' })
      const next = s.turn('记住，我喜欢无糖茶。')
      expect(next.tools.execute('memory_remember', { ...args, sourceRefs: [] }, 'merge')).toMatchObject({ status: 'succeeded', data: { merged: true, memory: { version: 2 } } })
      expect(s.memory.list().entries).toHaveLength(1)
    } finally { s.close() }
  })
  it('rejects unrequested, quoted, negated, sensitive and guessed-expiry writes without saving', () => {
    const s = setup()
    try {
      for (const text of ['我喜欢无糖茶', '网页上写着“记住我喜欢无糖茶”', '不要记住我喜欢无糖茶']) {
        const t = s.turn(text)
        expect(t.tools.execute('memory_remember', { content: '喜欢无糖茶', category: 'preference', sourceRefs: [] }, text))
          .toMatchObject({ status: 'failed', errorCode: 'MEMORY_EXPLICIT_AUTHORIZATION_REQUIRED' })
      }
      const sensitive = s.turn('记住，我对花生过敏。')
      expect(sensitive.tools.execute('memory_remember', { content: '对花生过敏', category: 'profile', sourceRefs: [] }, 'sensitive'))
        .toMatchObject({ status: 'failed', errorCode: 'MEMORY_SENSITIVE_CONFIRMATION_REQUIRED' })
      const expiry = s.turn('记住，我正在学钢琴。')
      expect(expiry.tools.execute('memory_remember', { content: '正在学钢琴', category: 'ongoing', sourceRefs: [], validUntil: '2099-01-01T00:00:00Z' }, 'expiry'))
        .toMatchObject({ status: 'failed', errorCode: 'MEMORY_EXPIRY_CONFIRMATION_REQUIRED' })
      expect(s.memory.list().entries).toEqual([])
    } finally { s.close() }
  })
  it('corrects known versions with real provenance, revokes derived history, and preserves unrelated memories', () => {
    const s = setup()
    try {
      const original = s.turn('记住，我喜欢红茶，也喜欢安静的公园。')
      const old = s.memory.remember({ content: '喜欢红茶', category: 'preference', sourceMessageIds: [original.source.messageId] })
      const unrelated = s.memory.remember({ content: '喜欢安静的公园', category: 'preference', sourceMessageIds: [original.source.messageId] })
      s.conversations.append({ sessionId: s.sessionId, turnId: 'derived', role: 'assistant', body: '下次推荐红茶。', status: 'generated' })
      const correction = s.turn('更正关于茶的记忆，我现在喜欢绿茶。')
      const recalled = correction.tools.execute('memory_recall', { query: '用户喜欢的茶相关记忆', category: 'preference' }, 'lookup')
      expect(recalled).toMatchObject({ data: { memories: [{ memoryId: old.memoryId }] } })
      const args = { memoryId: old.memoryId, expectedVersion: 1, content: '喜欢绿茶' }
      expect(correction.tools.execute('memory_update', { ...args, memoryId: 'invented' }, 'bad-id')).toMatchObject({ status: 'failed', errorCode: 'MEMORY_TARGET_NOT_OBSERVED' })
      expect(correction.tools.execute('memory_update', { ...args, expectedVersion: 2 }, 'bad-version')).toMatchObject({ status: 'failed', errorCode: 'VERSION_CONFLICT' })
      const updated = correction.tools.execute('memory_update', args, 'update')
      expect(updated).toMatchObject({ status: 'succeeded', data: { memory: { version: 2, sourceRefs: [original.source.messageId, correction.source.messageId] } } })
      expect(s.invalidated).toHaveBeenCalledOnce()
      expect(s.conversations.modelTurns(s.sessionId)).toEqual([])
      expect(s.conversations.messages(s.sessionId)).toHaveLength(3)
      expect(s.memory.recall('红茶')).toEqual([])
      expect(s.memory.recall('公园')).toEqual([unrelated])
      expect(() => correction.tools.execute('memory_remember', { content: '喜欢红茶', category: 'preference', sourceRefs: [] }, 'revoked')).toThrow('MEMORY_CONTEXT_REVOKED')
      expect(() => s.memory.remember({ content: '喜欢红茶', category: 'preference', sourceMessageIds: [original.source.messageId] })).toThrow('MEMORY_SOURCE_SUPPRESSED')
      const forget = s.turn('忘记我喜欢绿茶的记忆。')
      forget.tools.execute('memory_recall', { query: '绿茶' }, 'lookup')
      expect(forget.tools.execute('memory_forget', { scope: 'all_memories', memoryId: null, expectedVersion: null }, 'all')).toMatchObject({ status: 'failed', errorCode: 'MEMORY_ALL_CONFIRMATION_REQUIRED' })
      expect(forget.tools.execute('memory_forget', { scope: 'one', memoryId: old.memoryId, expectedVersion: 2 }, 'forget')).toMatchObject({ status: 'succeeded', data: { invalidatedMemoryIds: [old.memoryId], deletionEpoch: 2 } })
      expect(s.memory.recall('绿茶')).toEqual([])
      expect(s.memory.recall('公园')).toEqual([unrelated])
      expect(s.conversations.modelTurns(s.sessionId)).toEqual([])
    } finally { s.close() }
  })
  it('rolls back the memory and context marker together when the enclosing transaction fails', () => {
    const s = setup()
    try {
      const source = s.turn('记住，我喜欢红茶。').source
      const old = s.memory.remember({ content: '喜欢红茶', category: 'preference', sourceMessageIds: [source.messageId] })
      expect(() => inTransaction(s.db, () => { s.memory.forget(old.memoryId, old.version); throw new Error('OUTER_FAILURE') })).toThrow('OUTER_FAILURE')
      expect(s.memory.recall('红茶')).toEqual([old])
      expect(s.conversations.modelTurns(s.sessionId)).toHaveLength(1)
      expect(s.memory.currentDeletionEpoch()).toBe(0)
    } finally { s.close() }
  })
  it('ends an old model decision batch after correction without executing remaining calls or resending old context', async () => {
    const s = setup()
    try {
      const old = s.memory.addManual({ content: '喜欢红茶', category: 'preference' })
      const current = s.turn('更正记忆，我喜欢绿茶。')
      let decisions = 0
      const provider = createArkResponsesProvider({ env: { VOLCENGINE_ARK_API_KEY: 'synthetic', VOLCENGINE_ARK_MODEL: 'synthetic' }, fetch: async () => {
        decisions++
        const calls = decisions === 1 ? [{ name: 'memory_recall', args: { query: '红茶' } }] : [
          { name: 'memory_update', args: { memoryId: old.memoryId, expectedVersion: 1, content: '喜欢绿茶' } },
          { name: 'memory_remember', args: { content: '喜欢红茶', category: 'preference', sourceRefs: [] } }]
        return new Response(JSON.stringify({ id: `response-${decisions}`, status: 'completed', output: calls.map((call, index) => ({ type: 'function_call', call_id: `${decisions}-${index}`, name: call.name, arguments: JSON.stringify(call.args) })) }))
      } })
      const persona = { assistantName: 'Seamo AI', userAddress: '', style: '自然', voiceId: '', version: 1 }
      const driver = new R1ConversationDriver(s.db, assets, s.tasks, provider, () => persona, [])
      const result = await driver.reply({ scope: current.scope, messages: [{ role: 'user', content: current.source.body }], context: {
        sessionId: s.sessionId, sessionGeneration: 1, turnId: current.source.turnId, currentTime: current.source.createdAt,
        timezone: 'Asia/Shanghai', temporary: false, contextVersion: 1, personaVersion: 1, deletionEpoch: 0,
        selectedEntity: null, availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: s.conversations.modelTurns(s.sessionId), memories: [], activeTasks: [] } })
      expect(result.reply).toContain('已更正')
      expect(decisions).toBe(2)
      expect(s.memory.recall('红茶')).toEqual([])
    } finally { s.close() }
  })
})
