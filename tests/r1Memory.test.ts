import { describe, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1MemoryStore } from '../electron/main/r1/memory'

describe('R1 memory source and forgetting boundary', () => {
  it('normalizes explicit expiry offsets and rejects invalid calendar dates without a write', () => {
    const db = openR1Database(':memory:')
    try {
      const conversations = new R1Conversations(db), store = new R1MemoryStore(db)
      const source = conversations.append({ sessionId: conversations.start(), turnId: 'expiry', role: 'user', body: '记住这段近况', status: 'final' })
      expect(() => store.remember({ content: '近况', category: 'ongoing', sourceMessageIds: [source.messageId], expiresAt: '2099-02-30T08:00:00+08:00' })).toThrow('INVALID_EXPIRY')
      expect(store.list().entries).toEqual([])
      const saved = store.remember({ content: '近况', category: 'ongoing', sourceMessageIds: [source.messageId], expiresAt: '2099-01-01T08:00:00+08:00' })
      expect(saved.expiresAt).toBe('2099-01-01T00:00:00.000Z')
    } finally { db.close() }
  })
  it('keeps manual memory provenance separate from normal chat and enforces edit versions', () => {
    const db = openR1Database(':memory:')
    try {
      const memory = new R1MemoryStore(db)
      const saved = memory.addManual({ content: '周末喜欢安静的地方', category: 'preference' })
      expect(memory.list().entries).toEqual([saved])
      expect(memory.list({ query: '安静', page: 0, scope: 'about' }).entries).toEqual([saved])
      expect(memory.sources(saved.memoryId)).toMatchObject([{ body: '周末喜欢安静的地方' }])
      expect(new R1Conversations(db).listPersistentSessions()).toEqual([])
      const merged = memory.addManual({ content: '周末喜欢安静的地方', category: 'preference' })
      expect(merged.memoryId).toBe(saved.memoryId)
      expect(merged.version).toBe(2)
      expect(memory.sources(saved.memoryId)).toHaveLength(2)
      const corrected = memory.update({ memoryId: saved.memoryId, expectedVersion: merged.version,
        content: '周末喜欢安静的公园', category: 'preference' })
      expect(corrected.version).toBe(3)
      expect(corrected.deletionEpoch).toBeGreaterThan(merged.deletionEpoch)
      expect(memory.recall('安静')).toEqual([corrected])
      expect(memory.sources(saved.memoryId)).toMatchObject([{ body: '周末喜欢安静的地方' },
        { body: '周末喜欢安静的地方' }])
      expect(() => memory.update({ memoryId: saved.memoryId, expectedVersion: 1,
        content: '过期修改', category: 'preference' })).toThrow('VERSION_CONFLICT')
      memory.forget(corrected.memoryId, corrected.version)
      expect(memory.list().entries).toEqual([])
      expect(() => memory.sources(saved.memoryId)).toThrow('MEMORY_NOT_FOUND')
    } finally { db.close() }
  })

  it('saves only a persistent user source, excludes temporary recall, and suppresses forgotten memory', () => {
    const db = openR1Database(':memory:')
    try {
      const conversations = new R1Conversations(db)
      const temp = conversations.start(true)
      const tempMessage = conversations.append({ sessionId: temp, turnId: 'temporary',
        role: 'user', body: '临时内容', status: 'final' })
      const memory = new R1MemoryStore(db)
      expect(() => memory.remember({ content: '临时内容', category: 'preference',
        sourceMessageIds: [tempMessage.messageId] })).toThrow('MEMORY_SOURCE_NOT_PERSISTED')
      const normal = conversations.start()
      const source = conversations.append({ sessionId: normal, turnId: 'turn-1',
        role: 'user', body: '我喜欢爵士乐', status: 'final' })
      const saved = memory.remember({ content: '喜欢爵士乐', category: 'preference',
        sourceMessageIds: [source.messageId] })
      expect(memory.recall('爵士')).toEqual([saved])
      expect(memory.recall('爵士', true)).toEqual([])
      const forgotten = memory.forget(saved.memoryId, saved.version)
      expect(forgotten.deletionEpoch).toBeGreaterThan(0)
      expect(memory.recall('爵士')).toEqual([])
      expect(() => memory.forget(saved.memoryId, saved.version)).toThrow('MEMORY_NOT_FOUND')
      expect(db.prepare('SELECT COUNT(*) AS count FROM source_suppression').get())
        .toMatchObject({ count: 1 })
    } finally { db.close() }
  })

  it('invalidates a topic that cites a forgotten memory', () => {
    const db = openR1Database(':memory:')
    try {
      const conversations = new R1Conversations(db)
      const sessionId = conversations.start()
      const source = conversations.append({ sessionId, turnId: 'turn-1', role: 'user',
        body: '正在学钢琴', status: 'final' })
      const memory = new R1MemoryStore(db)
      const saved = memory.remember({ content: '正在学钢琴', category: 'ongoing',
        sourceMessageIds: [source.messageId] })
      db.prepare(`INSERT INTO topics
        (topic_id, title, summary, unresolved_json, source_refs_json, status, version, updated_at)
        VALUES ('topic-1', '钢琴', '在学', '[]', ?, 'active', 1, ?)`)
        .run(JSON.stringify([saved.memoryId]), new Date().toISOString())
      const { deletionEpoch } = memory.forget(saved.memoryId, 1)
      expect(db.prepare('SELECT deleted_at, deletion_epoch FROM topics WHERE topic_id = ?')
        .get('topic-1')).toMatchObject({ deleted_at: expect.any(String), deletion_epoch: deletionEpoch })
    } finally { db.close() }
  })
})

it('recalls actual facts from multi-term natural query phrases without unrelated filler', () => {
  const db = openR1Database(':memory:'), memory = new R1MemoryStore(db)
  try {
    const tea = memory.addManual({ content: '用户喜欢无糖绿茶。', category: 'preference' })
    const movie = memory.addManual({ content: '用户看电影更喜欢科幻片。', category: 'preference' })
    const project = memory.addManual({ content: '提案项目先支持macOS桌面版。', category: 'conclusion' })
    memory.addManual({ content: '红豆项目等待正式报价。', category: 'conclusion' })
    expect(memory.recall('喝茶习惯 是否加糖 偏好')).toEqual([tea])
    expect(memory.recall('电影题材偏好 喜欢看什么类型的电影')).toEqual([movie])
    expect(memory.recall('提案项目 优先支持平台')).toEqual([project])
    expect(memory.recall('无关的北极光')).toEqual([])
    expect(memory.recall('记忆 偏好 相关')).toEqual([])
    memory.forget(tea.memoryId, tea.version)
    expect(memory.recall('喝茶习惯 是否加糖 偏好')).toEqual([])
  } finally { db.close() }
})
it('does not confuse a different named entity on a single shared character', () => {
  const db = openR1Database(':memory:'), memory = new R1MemoryStore(db)
  try {
    memory.addManual({ content: '用户在北京工作。', category: 'profile' })
    expect(memory.recall('南京')).toEqual([])
    expect(memory.recall('南京', false, 'preference')).toEqual([])
  } finally { db.close() }
})
it('keeps a named lookup specific even when the query also contains common topic words', () => {
  const db = openR1Database(':memory:'), memory = new R1MemoryStore(db)
  try {
    const target = memory.addManual({ content: '合成项目SOLAR8427使用蓝色笔记本。', category: 'profile' })
    memory.addManual({ content: '合成项目SOLAR84270使用蓝色笔记本。', category: 'profile' })
    memory.addManual({ content: '合成项目SOLAR1000使用蓝色笔记本。', category: 'profile' })
    expect(memory.recall('SOLAR8427 项目笔记')).toEqual([target])
  } finally { db.close() }
})
it('honors the retrieval limit and reports deadline expiry as failure, never an empty match', () => {
  const db = openR1Database(':memory:'), memory = new R1MemoryStore(db, { limit: 1, budgetMs: 200 })
  try {
    memory.addManual({ content: '用户喜欢无糖绿茶。', category: 'preference' })
    memory.addManual({ content: '用户有时喝红茶。', category: 'preference' })
    expect(memory.recall('茶')).toHaveLength(1)
    let clock = 0
    const timed = new R1MemoryStore(db, { limit: 5, budgetMs: 1 }, () => clock++)
    expect(() => timed.recall('茶')).toThrow('MEMORY_RECALL_TIMEOUT')
    expect(timed.recall('茶', true)).toEqual([])
    expect(memory.list().entries).toHaveLength(2)
  } finally { db.close() }
})
