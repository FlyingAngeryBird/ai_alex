import { describe, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'

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
})
