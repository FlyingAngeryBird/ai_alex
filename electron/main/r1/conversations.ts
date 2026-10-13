import { randomUUID } from 'node:crypto'
import type { R1Database } from './database.js'

export type SessionMessage = {
  messageId: string
  sessionId: string
  turnId: string
  responseId: string | null
  role: 'user' | 'assistant' | 'system'
  body: string
  status: string
  playedUntilMs: number | null
  createdAt: string
}

type TemporarySession = { messages: SessionMessage[]; active: boolean }

export class R1Conversations {
  private readonly temporary = new Map<string, TemporarySession>()

  constructor(private readonly db: R1Database) {}

  start(temporary = false): string {
    const id = randomUUID()
    if (temporary) {
      this.temporary.set(id, { messages: [], active: true })
    } else {
      this.db.prepare(`INSERT INTO sessions (session_id, temporary, status, created_at)
        VALUES (?, 0, 'active', ?)`).run(id, new Date().toISOString())
    }
    return id
  }

  append(input: { sessionId: string; turnId: string; responseId?: string;
    role: SessionMessage['role']; body: string; status: string; playedUntilMs?: number }): SessionMessage {
    if (!input.body || [...input.body].length > 8000) throw new Error('INVALID_MESSAGE_BODY')
    if (!['user', 'assistant', 'system'].includes(input.role)) throw new Error('INVALID_MESSAGE_ROLE')
    const message: SessionMessage = { messageId: randomUUID(), sessionId: input.sessionId,
      turnId: input.turnId, responseId: input.responseId ?? null,
      role: input.role, body: input.body, status: input.status,
      playedUntilMs: input.playedUntilMs ?? null, createdAt: new Date().toISOString() }
    const temp = this.temporary.get(input.sessionId)
    if (temp) {
      if (!temp.active) throw new Error('SESSION_ENDED')
      temp.messages.push(message)
      return message
    }
    const session = this.db.prepare('SELECT status FROM sessions WHERE session_id = ? AND temporary = 0')
      .get(input.sessionId) as { status: string } | undefined
    if (!session || session.status !== 'active') throw new Error('SESSION_NOT_ACTIVE')
    this.db.prepare(`INSERT INTO messages
      (message_id, session_id, turn_id, response_id, role, body, status, played_until_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(message.messageId, message.sessionId,
      message.turnId, message.responseId, message.role, message.body, message.status,
      message.playedUntilMs, message.createdAt)
    return message
  }

  messages(sessionId: string): SessionMessage[] {
    const temp = this.temporary.get(sessionId)
    if (temp) return temp.messages.map((message) => ({ ...message }))
    const session = this.db.prepare('SELECT 1 FROM sessions WHERE session_id = ? AND temporary = 0')
      .get(sessionId)
    if (!session) throw new Error('SESSION_NOT_FOUND')
    const rows = this.db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid')
      .all(sessionId) as {
      message_id: string; session_id: string; turn_id: string; response_id: string | null
      role: SessionMessage['role']; body: string; status: string; played_until_ms: number | null;
      created_at: string
    }[]
    return rows.map((row) => ({ messageId: row.message_id, sessionId: row.session_id,
      turnId: row.turn_id, responseId: row.response_id, role: row.role, body: row.body,
      status: row.status, playedUntilMs: row.played_until_ms, createdAt: row.created_at }))
  }

  isTemporary(sessionId: string): boolean {
    return this.temporary.has(sessionId)
  }

  end(sessionId: string): void {
    if (this.temporary.has(sessionId)) {
      this.temporary.delete(sessionId)
      return
    }
    this.db.prepare("UPDATE sessions SET status = 'ended', ended_at = ? WHERE session_id = ? AND status = 'active'")
      .run(new Date().toISOString(), sessionId)
  }

  listPersistentSessions(): string[] {
    return (this.db.prepare(`SELECT session_id FROM sessions WHERE temporary = 0
      AND status <> 'memory_source' ORDER BY created_at DESC`)
      .all() as { session_id: string }[]).map((row) => row.session_id)
  }
}
