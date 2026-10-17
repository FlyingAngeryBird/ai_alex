import type { R1Database } from './database.js'

export type DeliveryAuditSubject = { kind: 'reminder' | 'missed_reminder' | 'follow_up' | 'focus_completed' | 'task_result'
  reminderId?: string | null; focusId?: string | null; taskId?: string | null; resultId?: string | null }
export type DeliveryPlaybackStatus = 'started' | 'playing' | 'completed' | 'interrupted'

/**
 * Durable audit of what actually reached the device. A due reminder, a card or
 * generated text never counts as announced: only native playback receipts do.
 * `announced_at` is the first audible receipt; `completed_at` is a full playback.
 */
export class R1DeliveryAudit {
  constructor(private readonly db: R1Database, private readonly now: () => string = () => new Date().toISOString()) {}

  record(subject: DeliveryAuditSubject, input: { requestId: string; responseId: string; status: DeliveryPlaybackStatus;
    playedUntilMs: number }): void {
    if (!subject || !['reminder', 'missed_reminder', 'follow_up', 'focus_completed', 'task_result'].includes(subject.kind) ||
      !input || typeof input.requestId !== 'string' || !input.requestId || input.requestId.length > 160 ||
      typeof input.responseId !== 'string' || !input.responseId || input.responseId.length > 160 ||
      !['started', 'playing', 'completed', 'interrupted'].includes(input.status) ||
      !Number.isSafeInteger(input.playedUntilMs) || input.playedUntilMs < 0) throw new Error('DELIVERY_AUDIT_INVALID')
    const now = this.now()
    const audible = input.status === 'started' || input.status === 'playing' || input.status === 'completed'
    this.db.prepare(`INSERT INTO delivery_announcements
      (request_id, kind, reminder_id, focus_id, task_id, result_id, response_id, status, played_ms,
       announced_at, completed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        status = excluded.status,
        played_ms = excluded.played_ms,
        announced_at = COALESCE(delivery_announcements.announced_at, excluded.announced_at),
        completed_at = COALESCE(delivery_announcements.completed_at, excluded.completed_at),
        updated_at = excluded.updated_at`)
      .run(input.requestId, subject.kind, subject.reminderId ?? null, subject.focusId ?? null,
        subject.taskId ?? null, subject.resultId ?? null, input.responseId, input.status, input.playedUntilMs,
        audible ? now : null, input.status === 'completed' ? now : null, now)
  }

  list(limit = 50): Array<{ requestId: string; kind: string; reminderId: string | null; focusId: string | null;
    taskId: string | null; resultId: string | null; status: string; playedMs: number;
    announcedAt: string | null; completedAt: string | null }> {
    const size = Number.isSafeInteger(limit) && limit > 0 && limit <= 100 ? limit : 50
    return (this.db.prepare(`SELECT * FROM delivery_announcements ORDER BY updated_at DESC LIMIT ?`).all(size) as Array<{
      request_id: string; kind: string; reminder_id: string | null; focus_id: string | null; task_id: string | null;
      result_id: string | null; status: string; played_ms: number; announced_at: string | null; completed_at: string | null
    }>).map(row => ({ requestId: row.request_id, kind: row.kind, reminderId: row.reminder_id, focusId: row.focus_id,
      taskId: row.task_id, resultId: row.result_id, status: row.status, playedMs: row.played_ms,
      announcedAt: row.announced_at, completedAt: row.completed_at }))
  }
}
