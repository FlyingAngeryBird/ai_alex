import { describe, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Focus, type FocusEvent } from '../electron/main/r1/focus'

function setup() {
  const db = openR1Database(':memory:')
  let clockMs = 0
  const focus = new R1Focus(db, () => clockMs)
  const events: FocusEvent[] = []
  focus.onChanged(event => events.push(event))
  return { db, focus, events, advance: (ms: number) => { clockMs += ms } }
}
describe('R1 independent focus timer', () => {
  it('uses monotonic elapsed time, pauses without completing, resumes and completes exactly once', () => {
    const { db, focus, events, advance } = setup()
    try {
      const started = focus.start({ actionId: 'start', durationSec: 60, endMusicRule: 'none' })
      advance(12_500)
      expect(focus.getState()).toMatchObject({ remainingSec: 48, state: 'running', version: 1 })
      const paused = focus.pause({ actionId: 'pause', focusId: started.focus.focusId, expectedVersion: 1 })
      expect(paused.focus).toMatchObject({ state: 'paused', remainingSec: 48, version: 2 })
      advance(200_000)
      expect(focus.getState()).toMatchObject({ state: 'paused', remainingSec: 48 })
      focus.resume({ actionId: 'resume', focusId: started.focus.focusId, expectedVersion: 2 })
      advance(47_500)
      expect(focus.getState()).toMatchObject({ state: 'completed', remainingSec: 0, version: 4 })
      focus.tick()
      expect(events.filter(event => event.reason === 'completed')).toHaveLength(1)
      expect(db.prepare('SELECT COUNT(*) AS count FROM items').get()).toMatchObject({ count: 0 })
      expect(db.prepare('SELECT COUNT(*) AS count FROM reminders').get()).toMatchObject({ count: 0 })
    } finally { focus.close(); db.close() }
  })
  it('deduplicates starts and controls and refuses stale versions or a second active timer', () => {
    const { db, focus } = setup()
    try {
      const input = { actionId: 'start', durationSec: 1500, endMusicRule: 'none' as const }
      const started = focus.start(input)
      expect(focus.start(input)).toEqual(started)
      expect(() => focus.start({ ...input, durationSec: 600 })).toThrow('ACTION_ID_REUSED')
      expect(() => focus.start({ ...input, actionId: 'other' })).toThrow('FOCUS_ALREADY_ACTIVE')
      const command = { actionId: 'pause', focusId: started.focus.focusId, expectedVersion: 1 }
      const paused = focus.pause(command)
      expect(focus.pause(command)).toEqual(paused)
      expect(() => focus.stop({ ...command, actionId: 'stale' })).toThrow('VERSION_CONFLICT')
      expect(focus.stop({ ...command, actionId: 'stop', expectedVersion: 2 }).focus.state).toBe('stopped')
      expect(focus.start({ ...input, actionId: 'new' }).focus.state).toBe('running')
    } finally { focus.close(); db.close() }
  })
  it('freezes on suspend and restart without counting sleeping time as completion', () => {
    const { db, focus, advance } = setup()
    try {
      const started = focus.start({ actionId: 'start', durationSec: 1500, endMusicRule: 'none' })
      advance(20_000)
      focus.suspend()
      advance(3_600_000)
      expect(focus.getState()).toMatchObject({ state: 'paused', remainingSec: 1480 })
      expect(() => focus.resume({ actionId: 'asleep', focusId: started.focus.focusId, expectedVersion: 2 }))
        .toThrow('FOCUS_DEVICE_SUSPENDED')
      focus.wake()
      focus.resume({ actionId: 'resume', focusId: started.focus.focusId, expectedVersion: 2 })
      advance(5000)
      focus.tick()
      const restarted = new R1Focus(db, () => 0)
      expect(restarted.getState()).toMatchObject({ focusId: started.focus.focusId, state: 'paused', remainingSec: 1475, version: 4 })
      restarted.close()
    } finally { focus.close(); db.close() }
  })
  it('validates duration and binds an explicitly selected track without operating the player', () => {
    const { db, focus, advance, events } = setup()
    try {
      for (const durationSec of [0, 59, 10801, 90.5]) {
        expect(() => focus.start({ actionId: `bad-${durationSec}`, durationSec, endMusicRule: 'none' })).toThrow('INVALID_FOCUS_START')
      }
      expect(() => focus.start({ actionId: 'no-track', durationSec: 60, endMusicRule: 'pause_user_selected_track' }))
        .toThrow('FOCUS_REQUIRES_SELECTED_TRACK')
      focus.start({ actionId: 'selected', durationSec: 60, endMusicRule: 'pause_user_selected_track', endTargetTrackKey: 'netease:123' })
      advance(60_000)
      focus.tick()
      expect(events.find(event => event.reason === 'completed')?.focus).toMatchObject({
        endMusicRule: 'pause_user_selected_track', endTargetTrackKey: 'netease:123' })
    } finally { focus.close(); db.close() }
  })
})
