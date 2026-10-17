import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1Topics } from '../electron/main/r1/topics'
import { R1MemoryStore } from '../electron/main/r1/memory'
import { R1MemoryPolicy } from '../electron/main/r1/memoryPolicy'
import { R1TopicSummaries } from '../electron/main/r1/topicSummaries'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { createArkResponsesProvider } from '../electron/main/providers/arkResponsesProvider'
import { registerTopicHandlers } from '../electron/main/ipc/topicHandlers'
import { topicConversationContext } from '../electron/main/r1/topicContext'
vi.mock('electron', () => ({ ipcMain: { handle() {} } }))
const assets = loadR1PromptAssets(resolve('r1-assets'))
function fixture() {
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db), memory = new R1MemoryStore(db), topics = new R1Topics(db), policy = new R1MemoryPolicy(db)
  const sessionId = conversations.start(); policy.update({ enabled: true, expectedVersion: 1 })
  const user = conversations.append({ sessionId, turnId: 'actual', role: 'user', body: '先做 macOS 桌面版，再决定移动版。还没确定发布日期。', status: 'final' })
  const assistant = conversations.append({ sessionId, turnId: 'actual', role: 'assistant', body: '可以先列出验收范围。', status: 'generated' })
  const result = { summary: '先开发 macOS 桌面版，移动版暂未决定。', sourceTurnIds: [user.turnId], memoryIds: [], taskFacts: [],
    topic: { topicId: null, expectedVersion: null, title: '桌面版开发', unresolved: ['发布日期尚未确定'], status: 'active' as const } }
  const save = () => topics.commitSummary({ result, sources: [user, assistant], existingTopics: [], authorizationVersion: 2, deletionEpoch: memory.currentDeletionEpoch(), assertCurrent() {} })!
  return { db, conversations, memory, topics, policy, sessionId, user, assistant, result, save }
}
describe('real Topic lifecycle and current context', () => {
  it('keeps actual sources and conclusion versions, and injects only the selected current version', () => {
    const s = fixture()
    try {
      const topic = s.save(), mode = { temporary: false, selectedTopic: { topicId: topic.topicId, version: topic.version } }
      expect(s.topics.list({ query: '桌面' }).entries).toEqual([topic]); expect(s.topics.sources(topic.topicId)).toMatchObject([{ messageId: s.user.messageId }, { messageId: s.assistant.messageId }])
      expect(s.topics.related(topic.topicId).sessionIds).toEqual([s.sessionId])
      expect(topicConversationContext(s.db, mode)).toMatchObject({ selected: { type: 'topic', id: topic.topicId, version: 1 }, topics: [{ summary: s.result.summary }] })
      const changed = s.topics.update({ topicId: topic.topicId, expectedVersion: 1, title: topic.title, summary: '先完成桌面版的内部验收，日期确定为下月。', unresolved: [], status: 'resolved' })
      expect(changed).toMatchObject({ version: 2, deletionEpoch: 1, status: 'resolved' })
      expect(s.topics.versions(topic.topicId)).toMatchObject([{ version: 2, origin: 'user' }, { version: 1, origin: 'summary' }])
      expect(s.topics.sources(topic.topicId).at(-1)?.body).toContain('内部验收')
      expect(s.conversations.modelTurns(s.sessionId)).toEqual([])
      mode.selectedTopic.version = 2
      expect(topicConversationContext(s.db, mode).topics[0].summary).toContain('日期确定')
      expect(() => s.topics.update({ topicId: topic.topicId, expectedVersion: 1, title: topic.title, summary: '旧更正', unresolved: [], status: 'active' })).toThrow('VERSION_CONFLICT')
      s.topics.forget({ topicId: topic.topicId, expectedVersion: 2 })
      expect(s.topics.list().entries).toEqual([]); expect(() => s.topics.versions(topic.topicId)).toThrow('TOPIC_NOT_FOUND')
      expect(topicConversationContext(s.db, mode)).toEqual({ selected: null, topics: [] })
      expect(s.conversations.messages(s.sessionId)).toHaveLength(2)
    } finally { s.db.close() }
  })
  it.each(['source', 'target', 'authorization', 'epoch', 'unheard', 'no-user'] as const)('rejects %s without creating a Topic or a version', reason => {
    const s = fixture()
    try {
      const input = { result: structuredClone(s.result), sources: [s.user, s.assistant], existingTopics: [], authorizationVersion: 2, deletionEpoch: 0, assertCurrent() {} }
      if (reason === 'source') input.result.sourceTurnIds = ['invented']
      if (reason === 'target') Object.assign(input.result.topic, { topicId: 'invented', expectedVersion: 1 })
      if (reason === 'authorization') s.policy.update({ enabled: false, expectedVersion: 2 })
      if (reason === 'epoch') { const memory = s.memory.addManual({ content: '旧事实', category: 'profile' }); s.memory.forget(memory.memoryId, memory.version) }
      if (reason === 'unheard') { s.db.prepare("UPDATE messages SET status='interrupted' WHERE message_id=?").run(s.assistant.messageId) }
      if (reason === 'no-user') input.sources = [s.assistant]
      expect(() => s.topics.commitSummary(input)).toThrow()
      expect(s.topics.list().entries).toEqual([]); expect(s.db.prepare('SELECT COUNT(*) AS n FROM topic_versions').get()).toMatchObject({ n: 0 })
    } finally { s.db.close() }
  })
  it('invalidates a summary derived from a corrected or forgotten Memory source', () => {
    for (const action of ['correct', 'forget'] as const) {
      const s = fixture()
      try {
        const topic = s.save(), memory = s.memory.remember({ content: '先做 macOS 桌面版', category: 'ongoing', sourceMessageIds: [s.user.messageId] })
        if (action === 'correct') s.memory.update({ memoryId: memory.memoryId, expectedVersion: 1, content: '先做网页版本', category: 'ongoing' })
        else s.memory.forget(memory.memoryId, 1)
        expect(() => s.topics.get(topic.topicId)).toThrow('TOPIC_NOT_FOUND')
      } finally { s.db.close() }
    }
  })
  it('enforces actual versions and temporary isolation through IPC', () => {
    const s = fixture(), handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>(), mode = { temporary: false }, invalidated = vi.fn()
    try {
      const topic = s.save(); registerTopicHandlers(s.db, mode, invalidated, () => ({ state: 'idle', code: null }), () => {}, { handle(name, handler) { handlers.set(name, handler) } })
      expect(handlers.get('r1.topics.select')!(null, { topicId: topic.topicId, expectedVersion: 0 })).toMatchObject({ ok: false })
      expect(handlers.get('r1.topics.select')!(null, { topicId: topic.topicId, expectedVersion: 1 })).toMatchObject({ ok: true })
      expect(handlers.get('r1.topics.forget')!(null, { topicId: topic.topicId, expectedVersion: 1, authorized: true })).toMatchObject({ ok: false })
      mode.temporary = true
      for (const handler of handlers.values()) expect(handler(null, { topicId: topic.topicId, expectedVersion: 1 })).toMatchObject({ ok: false, error: { code: 'MEMORY_UNAVAILABLE_IN_TEMPORARY_SESSION' } })
      expect(invalidated).not.toHaveBeenCalled(); expect(s.topics.get(topic.topicId)).toEqual(topic)
    } finally { s.db.close() }
  })
})

describe('authorized PR06 topic preparation', () => {
  function summaryFixture() {
    const s = fixture(); let release: (value: unknown) => void = () => { throw new Error('REQUEST_NOT_STARTED') }
    const requests: Record<string, unknown>[] = [], invalidated = vi.fn()
    const provider = createArkResponsesProvider({ env: { VOLCENGINE_ARK_API_KEY: 'synthetic', VOLCENGINE_ARK_MODEL: 'synthetic' }, fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init!.body)))
      return new Promise<Response>(resolve => { release = value => resolve(new Response(JSON.stringify({ id: 'summary', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }))) })
    } })
    let current = true
    const service = new R1TopicSummaries(s.db, assets, s.conversations, provider, { personaVersion: () => 1, configurationRevision: () => 1, onChanged() {}, onInvalidated: invalidated })
    function turn(index: number, temporary = false) {
      const sessionId = temporary ? s.conversations.start(true) : s.sessionId
      const source = s.conversations.append({ sessionId, turnId: `user-${index}`, role: 'user', body: `第${index}轮：桌面版先完成文字体验，发布日期待定。`, status: 'final' })
      s.conversations.append({ sessionId, turnId: source.turnId, role: 'assistant', body: '先保留这些已确认条件。', status: 'generated' })
      service.enqueue({ source, temporary, assertSession() { if (!current) throw new Error('SUMMARY_CONTEXT_REVOKED') } }); return source
    }
    return { ...s, service, requests, invalidated, turn, release: (value: unknown) => release(value), stale: () => { current = false },
      async close() { service.close(); await service.whenIdle(); s.db.close() } }
  }
  it('waits for the registered local capacity, keeps tools off, and saves actual current-turn provenance', async () => {
    const s = summaryFixture()
    try {
      for (let i = 2; i <= 8; i++) s.turn(i)
      expect(s.requests).toHaveLength(0)
      const source = s.turn(9)
      expect(s.requests).toHaveLength(1); expect(s.requests[0].tools).toEqual([]); expect(s.requests[0].store).toBe(false)
      s.release({ ...s.result, sourceTurnIds: [source.turnId] }); await s.service.whenIdle()
      expect(s.topics.list().entries).toMatchObject([{ title: '桌面版开发', version: 1, sourceRefs: [source.messageId, expect.any(String)] }])
      expect(s.topics.sources(s.topics.list().entries[0].topicId)).toEqual(expect.arrayContaining([expect.objectContaining({ body: source.body })]))
    } finally { await s.close() }
  })
  it.each(['off', 'off-on', 'session', 'source', 'forget'] as const)('rejects a late summary after %s', async reason => {
    const s = summaryFixture()
    try {
      for (let i = 2; i <= 9; i++) s.turn(i)
      if (reason === 'off' || reason === 'off-on') { s.policy.update({ enabled: false, expectedVersion: 2 }); if (reason === 'off-on') s.policy.update({ enabled: true, expectedVersion: 3 }) }
      if (reason === 'session') s.stale()
      if (reason === 'source') s.db.prepare('UPDATE messages SET body=? WHERE message_id=?').run('已变更来源', s.user.messageId)
      if (reason === 'forget') { const old = s.memory.addManual({ content: '旧事实', category: 'profile' }); s.memory.forget(old.memoryId, 1) }
      s.release({ ...s.result, sourceTurnIds: ['user-9'] }); await s.service.whenIdle()
      expect(s.topics.list().entries).toEqual([])
    } finally { await s.close() }
  })
  it.each(['valid', 'invalid', 'revoked'] as const)('runs at most one registered PR10 repair, then handles %s output', async outcome => {
    const s = summaryFixture()
    try {
      for (let i = 2; i <= 9; i++) s.turn(i)
      const invalid = { ...s.result, sourceTurnIds: ['forged-source'] }
      s.release(invalid)
      await vi.waitFor(() => expect(s.requests).toHaveLength(2))
      expect(s.requests[1].tools).toEqual([])
      expect(JSON.stringify(s.requests[1])).toContain('SUMMARY_OUTPUT_INVALID')
      if (outcome === 'revoked') s.policy.update({ enabled: false, expectedVersion: 2 })
      s.release(outcome === 'invalid' ? invalid : { ...s.result, sourceTurnIds: ['user-9'] })
      await s.service.whenIdle()
      expect(s.requests).toHaveLength(2)
      expect(s.topics.list().entries).toHaveLength(outcome === 'valid' ? 1 : 0)
      if (outcome === 'invalid') expect(s.service.getState()).toEqual({ state: 'failed', code: 'STRUCTURED_OUTPUT_INVALID' })
    } finally { await s.close() }
  })
  it('drops the superseded summary and coalesces the newest completed turn before a write', async () => {
    const s = summaryFixture()
    try {
      for (let i = 2; i <= 9; i++) s.turn(i)
      s.turn(10); const latest = s.turn(11)
      s.release({ ...s.result, sourceTurnIds: ['user-9'] })
      await vi.waitFor(() => expect(s.requests).toHaveLength(2))
      expect(s.topics.list().entries).toEqual([])
      s.release({ ...s.result, summary: '最新阶段决定已由第11轮确认。', sourceTurnIds: [latest.turnId] })
      await s.service.whenIdle()
      expect(s.topics.list().entries).toMatchObject([{ summary: '最新阶段决定已由第11轮确认。', sourceRefs: [latest.messageId, expect.any(String)] }])
      expect(s.requests).toHaveLength(2)
    } finally { await s.close() }
  })
  it('does not backfill pre-grant history or include a temporary session', async () => {
    const s = summaryFixture()
    try {
      s.policy.update({ enabled: false, expectedVersion: 2 })
      for (let i = 2; i <= 15; i++) s.turn(i)
      expect(s.requests).toHaveLength(0)
      s.policy.update({ enabled: true, expectedVersion: 3 }); s.turn(16); s.turn(17, true)
      expect(s.requests).toHaveLength(0); expect(s.topics.list().entries).toEqual([])
    } finally { await s.close() }
  })
  it('does not autosummarize a known sensitive source', async () => {
    const s = summaryFixture()
    try {
      s.db.prepare('UPDATE messages SET body=? WHERE message_id=?').run('我有偏头痛。', s.user.messageId)
      for (let i = 2; i <= 9; i++) s.turn(i)
      expect(s.requests).toHaveLength(0); expect(s.topics.list().entries).toEqual([])
    } finally { await s.close() }
  })
})

it('retrieves a current Topic from a natural multi-term query without confusing it with a Memory', async () => {
  const s = fixture()
  try {
    const saved = s.save()
    const { R1MemoryTools } = await import('../electron/main/r1/memoryTools')
    const tools = new R1MemoryTools(s.memory, s.user, s.topics)
    const result = tools.execute('memory_recall', { query: '桌面版 项目开发结论 发布日期' })
    expect(result.data).toMatchObject({ matchStatus: 'matched', memories: [], topics: [{ topicId: saved.topicId, version: 1 }] })
    s.topics.forget({ topicId: saved.topicId, expectedVersion: 1 })
    expect(tools.execute('memory_recall', { query: '桌面版 项目开发结论 发布日期' }).data)
      .toMatchObject({ matchStatus: 'no_match', memories: [], topics: [] })
    expect(() => s.topics.recall('桌面版', { limit: 5, assertBudget() { throw new Error('MEMORY_RECALL_TIMEOUT') } }))
      .toThrow('MEMORY_RECALL_TIMEOUT')
  } finally { s.db.close() }
})

it('does not authorize a hidden Memory target when the combined Topic lookup fails', async () => {
  const s = fixture()
  try {
    const saved = s.memory.addManual({ content: '用户喜欢无糖绿茶', category: 'preference' })
    const source = s.conversations.append({ sessionId: s.sessionId, turnId: 'correction', role: 'user', body: '更正关于茶的记忆，改成红茶。', status: 'final' })
    const { R1MemoryTools } = await import('../electron/main/r1/memoryTools')
    const tools = new R1MemoryTools(s.memory, source, s.topics)
    vi.spyOn(s.topics, 'recall').mockImplementationOnce(() => { throw new Error('MEMORY_RECALL_TIMEOUT') })
    expect(() => tools.execute('memory_recall', { query: '茶' })).toThrow('MEMORY_RECALL_TIMEOUT')
    expect(() => tools.execute('memory_update', { memoryId: saved.memoryId, expectedVersion: 1, content: '用户喜欢红茶' }))
      .toThrow('MEMORY_TARGET_NOT_OBSERVED')
    expect(s.memory.list().entries).toEqual([saved])
  } finally { s.db.close() }
})
