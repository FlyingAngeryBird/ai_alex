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

export type HistorySession = { sessionId: string; title: string; createdAt: string;
  lastMessageAt: string; messageCount: number }
export type HistoryPage = { sessions: HistorySession[]; page: number; hasMore: boolean }

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

  modelTurns(sessionId: string) {
    return this.messages(sessionId).filter(message => message.role !== 'system').slice(-24).map(message => {
      const unconfirmedAudio = message.role === 'assistant' &&
        (message.status === 'interrupted' || message.playedUntilMs !== null && message.status !== 'heard')
      return { turnId: message.turnId, role: message.role, text: unconfirmedAudio ? '' : message.body,
        heardText: message.role === 'assistant' && message.status === 'heard' ? message.body : null,
        status: unconfirmedAudio ? 'interrupted' as const : 'valid' as const }
    })
  }

  recordPlayback(input: { sessionId: string; responseId: string; playedUntilMs: number;
    status: 'playing' | 'completed' | 'interrupted' }): void {
    if (!Number.isSafeInteger(input.playedUntilMs) || input.playedUntilMs < 0 || input.playedUntilMs > 3_600_000 ||
      !['playing', 'completed', 'interrupted'].includes(input.status)) throw new Error('INVALID_PLAYBACK_RECEIPT')
    const temp = this.temporary.get(input.sessionId)
    const status = input.status === 'completed' ? 'heard' : input.status === 'interrupted' ? 'interrupted' : 'generated'
    if (temp) {
      const message = temp.messages.find(message => message.responseId === input.responseId && message.role === 'assistant')
      if (!message || message.status === 'interrupted' || message.status === 'heard') return
      message.playedUntilMs = Math.max(message.playedUntilMs ?? 0, input.playedUntilMs); message.status = status
      return
    }
    this.db.prepare(`UPDATE messages SET played_until_ms = MAX(COALESCE(played_until_ms, 0), ?), status = ?
      WHERE session_id = ? AND response_id = ? AND role = 'assistant' AND status NOT IN ('interrupted', 'heard')`)
      .run(input.playedUntilMs, status, input.sessionId, input.responseId)
  }

  messages(sessionId: string): SessionMessage[] {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('INVALID_SESSION_ID')
    const temp = this.temporary.get(sessionId)
    if (temp) return temp.messages.map((message) => ({ ...message }))
    const session = this.db.prepare(`SELECT 1 FROM sessions WHERE session_id = ?
      AND temporary = 0 AND status <> 'memory_source'`)
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

  history(input: { query?: string; page?: number } = {}): HistoryPage {
    const query = input.query ?? ''
    const page = input.page ?? 0
    if (typeof query !== 'string' || [...query].length > 1000 ||
      !Number.isSafeInteger(page) || page < 0 || page > 100_000) throw new Error('INVALID_HISTORY_QUERY')
    const escaped = query.trim().replace(/[\\%_]/g, '\\$&')
    const rows = this.db.prepare(`SELECT s.session_id AS session_id,
      s.created_at AS created_at, MAX(m.created_at) AS last_message_at,
      COUNT(m.message_id) AS message_count,
      COALESCE((SELECT first.body FROM messages first WHERE first.session_id = s.session_id
        AND first.role = 'user' ORDER BY first.created_at, first.rowid LIMIT 1), '日常对话') AS title
      FROM sessions s JOIN messages m ON m.session_id = s.session_id
      WHERE s.temporary = 0 AND s.status <> 'memory_source'
        AND (? = '' OR EXISTS (SELECT 1 FROM messages matched
          WHERE matched.session_id = s.session_id AND matched.body LIKE ? ESCAPE '\\'))
      GROUP BY s.session_id ORDER BY last_message_at DESC, s.session_id DESC
      LIMIT 21 OFFSET ?`).all(query.trim(), `%${escaped}%`, page * 20) as {
      session_id: string; created_at: string; last_message_at: string;
      message_count: number; title: string
    }[]
    return { sessions: rows.slice(0, 20).map(row => ({ sessionId: row.session_id,
      title: [...row.title].slice(0, 80).join(''), createdAt: row.created_at,
      lastMessageAt: row.last_message_at, messageCount: row.message_count })),
      page, hasMore: rows.length > 20 }
  }
}
