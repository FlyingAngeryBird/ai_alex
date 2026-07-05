import { describe, expect, it } from 'vitest'
import {
  advanceMusicMelodyFlow,
  calculateMelodyRibbonLight,
  createMusicMelodyFlowState
} from '../src/utils/musicMelodyFlow'

describe('music melody flow', () => {
  it('moves the inner light upward when the melody contour rises', () => {
    let state = createMusicMelodyFlowState()

    state = advanceMusicMelodyFlow(state, {
      bass: 0.28,
      beat: 0.12,
      centroid: 0.28,
      flux: 0.04,
      mid: 0.42,
      treble: 0.18
    }, 0.08, true)
    state = advanceMusicMelodyFlow(state, {
      bass: 0.3,
      beat: 0.16,
      centroid: 0.62,
      flux: 0.16,
      mid: 0.64,
      treble: 0.42
    }, 0.08, true)

    expect(state.direction).toBeGreaterThan(0.22)
    expect(state.lift).toBeGreaterThan(0.08)
    expect(state.motion).toBeGreaterThan(0.45)
  })

  it('lets a falling melody pull the ribbon downward without requiring a song-type switch', () => {
    let state = createMusicMelodyFlowState()

    state = advanceMusicMelodyFlow(state, {
      bass: 0.34,
      beat: 0.22,
      centroid: 0.72,
      flux: 0.12,
      mid: 0.62,
      treble: 0.5
    }, 0.08, true)
    state = advanceMusicMelodyFlow(state, {
      bass: 0.32,
      beat: 0.18,
      centroid: 0.3,
      flux: 0.1,
      mid: 0.48,
      treble: 0.2
    }, 0.08, true)

    expect(state.direction).toBeLessThan(-0.22)
    expect(state.lift).toBeLessThan(0)
    expect(state.motion).toBeGreaterThan(0.45)
  })

  it('lights particles along the current melody ribbon more than distant particles', () => {
    const state = {
      ...createMusicMelodyFlowState(),
      angle: 0,
      glow: 0.86,
      lift: 0.18,
      motion: 0.58,
      sparkle: 0.42,
      width: 0.24
    }
    const onRibbon = calculateMelodyRibbonLight({
      directionX: 1,
      directionY: 0.18,
      directionZ: 0,
      layer: 1,
      phase: 0.3,
      radius: 0.54,
      seed: 0.42,
      state
    })
    const offRibbon = calculateMelodyRibbonLight({
      directionX: -0.15,
      directionY: -0.6,
      directionZ: 0.98,
      layer: 1,
      phase: 0.3,
      radius: 0.54,
      seed: 0.42,
      state
    })

    expect(onRibbon.ribbonLight).toBeGreaterThan(0.65)
    expect(onRibbon.ribbonLight).toBeGreaterThan(offRibbon.ribbonLight * 5)
    expect(onRibbon.melodyMilk).toBeGreaterThan(offRibbon.melodyMilk)
  })
})
