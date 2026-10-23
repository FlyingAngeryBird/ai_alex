import { describe, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1MemoryStore } from '../electron/main/r1/memory'

describe('R1 temporary conversation boundary', () => {
  it('keeps temporary messages in memory and destroys them on exit', () => {
    const db = openR1Database(':memory:')
    try {
      const conversations = new R1Conversations(db)
      const sessionId = conversations.start(true)
      conversations.append({ sessionId, turnId: 'turn-1', role: 'user',
        body: '临时想法', status: 'final' })
      expect(conversations.messages(sessionId)).toHaveLength(1)
      expect(db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toMatchObject({ count: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toMatchObject({ count: 0 })
      conversations.end(sessionId)
      expect(() => conversations.messages(sessionId)).toThrow('SESSION_NOT_FOUND')
    } finally { db.close() }
  })

  it('persists normal session messages with explicit turn and response IDs', () => {
    const db = openR1Database(':memory:')
    try {
      const conversations = new R1Conversations(db)
      const sessionId = conversations.start()
      const message = conversations.append({ sessionId, turnId: 'turn-1', responseId: 'response-1',
        role: 'assistant', body: '你好', status: 'played', playedUntilMs: 500 })
      expect(conversations.listPersistentSessions()).toContain(sessionId)
      expect(new R1Conversations(db).messages(sessionId)).toEqual([message])
      conversations.end(sessionId)
      expect(() => conversations.append({ sessionId, turnId: 'turn-2', role: 'user',
        body: '后来', status: 'final' })).toThrow('SESSION_NOT_ACTIVE')
    } finally { db.close() }
  })

  it('paginates searchable history and excludes empty, temporary and manual memory source sessions', () => {
    const db = openR1Database(':memory:')
    try {
      const conversations = new R1Conversations(db)
      conversations.start()
      const temp = conversations.start(true)
      conversations.append({ sessionId: temp, turnId: 'temp', role: 'user', body: '私密测试', status: 'final' })
      new R1MemoryStore(db).addManual({ content: '手工资料', category: 'preference' })
      for (let index = 0; index < 21; index += 1) {
        const sessionId = conversations.start()
        conversations.append({ sessionId, turnId: `user-${index}`, role: 'user',
          body: index === 0 ? '100% 的进度_确认' : `话题 ${index}`, status: 'final' })
        conversations.append({ sessionId, turnId: `assistant-${index}`, role: 'assistant',
          body: `回答 ${index}`, status: 'generated' })
        conversations.end(sessionId)
      }
      const first = conversations.history()
      const second = conversations.history({ page: 1 })
      expect(first.sessions).toHaveLength(20)
      expect(first.hasMore).toBe(true)
      expect(second.sessions).toHaveLength(1)
      expect(second.hasMore).toBe(false)
      expect(new Set([...first.sessions, ...second.sessions].map(session => session.sessionId)).size).toBe(21)
      expect(conversations.history({ query: '%' }).sessions).toHaveLength(1)
      expect(conversations.history({ query: '_' }).sessions).toHaveLength(1)
      expect(conversations.history({ query: '回答 20' }).sessions[0].title).toBe('话题 20')
      expect(conversations.history({ query: '手工资料' }).sessions).toHaveLength(0)
      const source = db.prepare("SELECT session_id FROM sessions WHERE status = 'memory_source'").get() as { session_id: string }
      expect(() => conversations.messages(source.session_id)).toThrow('SESSION_NOT_FOUND')
      expect(() => conversations.history({ page: -1 })).toThrow('INVALID_HISTORY_QUERY')
    } finally { db.close() }
  })
})
