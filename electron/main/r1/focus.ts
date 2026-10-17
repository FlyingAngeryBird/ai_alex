import { randomUUID } from 'node:crypto'
import { afterTransactionCommit, afterTransactionRollback, inTransaction, type R1Database } from './database.js'
import { receipt, runOnce, type ActionReceipt } from './items.js'

export type FocusState = {
  focusId: string; durationSec: number; remainingSec: number
  state: 'running' | 'paused' | 'completed' | 'stopped'; version: number
  endMusicRule: 'none' | 'pause_user_selected_track'; endTargetTrackKey: string | null
}
type FocusRow = { focus_id: string; duration_sec: number; remaining_sec: number;
  state: FocusState['state']; version: number; end_music_rule: FocusState['endMusicRule'];
  end_target_track_key: string | null }
export type FocusCommand = { actionId: string; focusId: string; expectedVersion: number }
type FocusResult = { focus: FocusState; receipt: ActionReceipt }
export type FocusEvent = { focus: FocusState; reason: 'started' | 'paused' | 'resumed' | 'stopped' | 'completed' | 'recovered' | 'tick'; deliveryId?: string }

const view = (row: FocusRow): FocusState => ({ focusId: row.focus_id, durationSec: row.duration_sec,
  remainingSec: Math.max(0, Math.ceil(row.remaining_sec)), state: row.state, version: row.version,
  endMusicRule: row.end_music_rule, endTargetTrackKey: row.end_target_track_key })

/** One main-process owner. Elapsed awake time comes from a monotonic clock, never a renderer timer. */
export class R1Focus {
  private anchor: { focusId: string; remainingSec: number; clockMs: number } | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false
  private suspended = false
  private readonly listeners = new Set<(event: FocusEvent) => void>()
  constructor(private readonly db: R1Database, private readonly clock: () => number = () => performance.now()) {
    inTransaction(db, () => {
      db.prepare(`UPDATE focus SET state = 'paused', version = version + 1, updated_at = ?
        WHERE state = 'running'`).run(new Date().toISOString())
    })
  }
  onChanged(listener: (event: FocusEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private recordRollback(): void {
    const anchor = this.anchor ? { ...this.anchor } : null, suspended = this.suspended
    afterTransactionRollback(this.db, () => { this.anchor = anchor; this.suspended = suspended })
  }
  private emit(focus: FocusState, reason: FocusEvent['reason']): void {
    const event = { focus: { ...focus }, reason }
    afterTransactionCommit(this.db, () => {
      for (const listener of this.listeners) {
        try { listener(event) } catch { /* State is already committed. */ }
      }
    })
  }
  private currentRow(): FocusRow | undefined {
    return this.db.prepare(`SELECT * FROM focus ORDER BY
      CASE WHEN state IN ('running', 'paused') THEN 0 ELSE 1 END, updated_at DESC, rowid DESC LIMIT 1`)
      .get() as FocusRow | undefined
  }
  getState(): FocusState | null {
    if (this.closed) throw new Error('FOCUS_SERVICE_CLOSED')
    this.tick()
    const row = this.currentRow()
    return row ? view(row) : null
  }
  start(input: { actionId: string; durationSec: number; endMusicRule: FocusState['endMusicRule'];
    endTargetTrackKey?: string | null }): FocusResult {
    if (this.closed) throw new Error('FOCUS_SERVICE_CLOSED')
    this.recordRollback()
    let committed = false
    const result = runOnce(this.db, input.actionId, input, () => {
      if (!Number.isInteger(input.durationSec) || input.durationSec < 60 || input.durationSec > 10800 ||
        !['none', 'pause_user_selected_track'].includes(input.endMusicRule)) throw new Error('INVALID_FOCUS_START')
      const target = input.endTargetTrackKey ?? null
      if (input.endMusicRule === 'none' && target !== null) throw new Error('INVALID_FOCUS_MUSIC_BINDING')
      if (input.endMusicRule === 'pause_user_selected_track' &&
        (typeof target !== 'string' || !target.trim() || [...target].length > 160)) {
        throw new Error('FOCUS_REQUIRES_SELECTED_TRACK')
      }
      if (this.suspended) throw new Error('FOCUS_DEVICE_SUSPENDED')
      if (this.db.prepare("SELECT 1 FROM focus WHERE state IN ('running', 'paused')").get()) {
        throw new Error('FOCUS_ALREADY_ACTIVE')
      }
      const focusId = randomUUID()
      this.db.prepare(`INSERT INTO focus (focus_id, duration_sec, remaining_sec, state, version,
        updated_at, end_music_rule, end_target_track_key) VALUES (?, ?, ?, 'running', 1, ?, ?, ?)`)
        .run(focusId, input.durationSec, input.durationSec, new Date().toISOString(), input.endMusicRule, target)
      committed = true
      return { focus: view(this.db.prepare('SELECT * FROM focus WHERE focus_id = ?').get(focusId) as FocusRow),
        receipt: receipt(input.actionId, focusId, 1, 'focus_started') }
    })
    if (committed) {
      this.anchor = { focusId: result.focus.focusId, remainingSec: input.durationSec, clockMs: this.clock() }
      this.emit(result.focus, 'started')
    }
    return result
  }
  private checked(input: FocusCommand): FocusRow {
    if (typeof input.focusId !== 'string' || !input.focusId ||
      !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('INVALID_FOCUS_COMMAND')
    const row = this.db.prepare('SELECT * FROM focus WHERE focus_id = ?').get(input.focusId) as FocusRow | undefined
    if (!row) throw new Error('FOCUS_NOT_FOUND')
    if (row.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
    return row
  }
  private change(input: FocusCommand, next: 'paused' | 'running' | 'stopped'): FocusResult {
    this.recordRollback()
    if (this.closed) throw new Error('FOCUS_SERVICE_CLOSED')
    this.tick()
    let committed = false
    const result = runOnce(this.db, input.actionId, { ...input, next }, () => {
      const row = this.checked(input)
      if (next === 'running' && this.suspended) throw new Error('FOCUS_DEVICE_SUSPENDED')
      if ((next === 'running' && row.state !== 'paused') ||
        (next === 'paused' && row.state !== 'running') ||
        (next === 'stopped' && !['running', 'paused'].includes(row.state))) throw new Error('FOCUS_INVALID_STATE')
      this.db.prepare(`UPDATE focus SET state = ?, version = version + 1, updated_at = ? WHERE focus_id = ?`)
        .run(next, new Date().toISOString(), row.focus_id)
      committed = true
      return { focus: view({ ...row, state: next, version: row.version + 1 }),
        receipt: receipt(input.actionId, row.focus_id, row.version + 1, `focus_${next === 'running' ? 'resumed' : next}`) }
    })
    if (committed) {
      const row = this.db.prepare('SELECT * FROM focus WHERE focus_id = ?').get(input.focusId) as FocusRow
      this.anchor = next === 'running' ? { focusId: row.focus_id, remainingSec: row.remaining_sec, clockMs: this.clock() } : null
      this.emit(result.focus, next === 'running' ? 'resumed' : next === 'paused' ? 'paused' : 'stopped')
    }
    return result
  }
  pause(input: FocusCommand): FocusResult { return this.change(input, 'paused') }
  resume(input: FocusCommand): FocusResult { return this.change(input, 'running') }
  stop(input: FocusCommand): FocusResult { return this.change(input, 'stopped') }
  tick(): void {
    if (this.closed) return
    const anchor = this.anchor
    if (!anchor || this.suspended) return
    this.recordRollback()
    const remaining = Math.max(0, anchor.remainingSec - Math.max(0, this.clock() - anchor.clockMs) / 1000)
    const completed = remaining === 0
    const changed = this.db.prepare(`UPDATE focus SET remaining_sec = ?, state = ?,
      version = version + ?, updated_at = ? WHERE focus_id = ? AND state = 'running'`)
      .run(remaining, completed ? 'completed' : 'running', completed ? 1 : 0,
        new Date().toISOString(), anchor.focusId)
    if (!changed.changes) { this.anchor = null; return }
    if (completed) this.anchor = null
    const row = this.db.prepare('SELECT * FROM focus WHERE focus_id = ?').get(anchor.focusId) as FocusRow
    this.emit(view(row), completed ? 'completed' : 'tick')
  }
  suspend(): void {
    this.recordRollback()
    this.tick()
    this.suspended = true
    const row = this.currentRow()
    if (row?.state === 'running') {
      this.db.prepare(`UPDATE focus SET state = 'paused', version = version + 1,
        updated_at = ? WHERE focus_id = ?`).run(new Date().toISOString(), row.focus_id)
      this.anchor = null
      this.emit(view({ ...row, state: 'paused', version: row.version + 1 }), 'recovered')
    }
  }
  wake(): void { this.suspended = false }
  startScheduler(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 1000)
  }
  close(): void {
    if (this.closed) return
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.suspend()
    this.closed = true
    this.listeners.clear()
  }
}
