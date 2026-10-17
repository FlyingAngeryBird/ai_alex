import { expect, it, vi } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1DeliveryAudit } from '../electron/main/r1/deliveryAudit'
import { R1ReminderDelivery } from '../electron/main/r1/reminderDelivery'
import { R1TaskDelivery } from '../electron/main/r1/taskDelivery'

function seededLedger() {
  return { playback: vi.fn(), interruptPending: vi.fn() }
}
function timer() { const value = setTimeout(() => undefined, 0); value.unref?.(); return value }

it('records announcedAt/completedAt only from actual playback receipts', () => {
  const db = openR1Database(':memory:')
  try {
    const audit = new R1DeliveryAudit(db, () => '2026-10-17T12:00:00.000Z')
    audit.record({ kind: 'reminder', reminderId: 'rem-1' }, { requestId: 'req-1', responseId: 'resp-1',
      status: 'started', playedUntilMs: 120 })
    let row = audit.list()[0]
    expect(row).toMatchObject({ kind: 'reminder', reminderId: 'rem-1', status: 'started', playedMs: 120,
      announcedAt: '2026-10-17T12:00:00.000Z', completedAt: null })
    audit.record({ kind: 'reminder', reminderId: 'rem-1' }, { requestId: 'req-1', responseId: 'resp-1',
      status: 'completed', playedUntilMs: 2400 })
    row = audit.list()[0]
    expect(row).toMatchObject({ status: 'completed', playedMs: 2400, announcedAt: '2026-10-17T12:00:00.000Z',
      completedAt: '2026-10-17T12:00:00.000Z' })
    audit.record({ kind: 'focus_completed', focusId: 'focus-1' }, { requestId: 'req-2', responseId: 'resp-2',
      status: 'interrupted', playedUntilMs: 300 })
    const interrupted = audit.list().find(item => item.requestId === 'req-2')
    expect(interrupted).toMatchObject({ kind: 'focus_completed', focusId: 'focus-1', status: 'interrupted',
      announcedAt: null, completedAt: null })
    expect(() => audit.record({ kind: 'reminder' }, { requestId: '', responseId: 'r', status: 'started', playedUntilMs: 1 }))
      .toThrow('DELIVERY_AUDIT_INVALID')
  } finally { db.close() }
})

it('links reminder playback to the real reminder/focus subject and rejects unstarted completion', () => {
  const db = openR1Database(':memory:')
  try {
    const audit = new R1DeliveryAudit(db)
    const delivery = new R1ReminderDelivery({ db, audit } as never)
    const ledger = seededLedger()
    ;(delivery as unknown as { playback: Map<string, unknown> }).playback.set('req-rem', { owner: 1, started: false,
      ledger, responseId: 'resp-rem', subject: { kind: 'follow_up', reminderId: 'rem-9' }, check: () => undefined, timer: timer() })
    expect(() => delivery.reportPlayback(1, { requestId: 'req-rem', status: 'completed', playedUntilMs: 1000 }))
      .toThrow('NOTICE_PLAYBACK_NOT_STARTED')
    delivery.reportPlayback(1, { requestId: 'req-rem', status: 'started', playedUntilMs: 100 })
    expect(audit.list()[0]).toMatchObject({ kind: 'follow_up', reminderId: 'rem-9', status: 'started', announcedAt: expect.any(String) })
    ;(delivery as unknown as { playback: Map<string, unknown> }).playback.set('req-focus', { owner: 1, started: false,
      ledger, responseId: 'resp-focus', subject: { kind: 'focus_completed', focusId: 'focus-3' }, check: () => undefined, timer: timer() })
    delivery.reportPlayback(1, { requestId: 'req-focus', status: 'started', playedUntilMs: 200 })
    delivery.reportPlayback(1, { requestId: 'req-focus', status: 'completed', playedUntilMs: 3400 })
    expect(audit.list().find(item => item.requestId === 'req-focus')).toMatchObject({ kind: 'focus_completed',
      focusId: 'focus-3', status: 'completed', completedAt: expect.any(String) })
  } finally { db.close() }
})

it('links task result playback to the original task and result', () => {
  const db = openR1Database(':memory:')
  try {
    const audit = new R1DeliveryAudit(db)
    const delivery = new R1TaskDelivery({ audit } as never)
    const ledger = seededLedger()
    ;(delivery as unknown as { playback: Map<string, unknown> }).playback.set('req-task', { owner: 2, started: false,
      ledger, responseId: 'resp-task', taskId: 'task-1', resultId: 'result-1', check: () => undefined, timer: timer() })
    delivery.reportPlayback(2, { requestId: 'req-task', status: 'started', playedUntilMs: 150 })
    delivery.reportPlayback(2, { requestId: 'req-task', status: 'completed', playedUntilMs: 4800 })
    expect(audit.list()[0]).toMatchObject({ kind: 'task_result', taskId: 'task-1', resultId: 'result-1',
      status: 'completed', playedMs: 4800, announcedAt: expect.any(String), completedAt: expect.any(String) })
  } finally { db.close() }
})
