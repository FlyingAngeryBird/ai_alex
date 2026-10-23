import { describe, expect, it } from 'vitest'
import {
  advanceMusicAuraEngine,
  calculateCoreReactor,
  createMusicAuraEngineState,
  detectSongMood
} from '../src/utils/musicAuraEngine'

describe('music aura engine rhythm field', () => {
  it('classifies soft pop and strong songs into different rhythm field moods', () => {
    expect(detectSongMood({
      bass: 0.26,
      beat: 0.08,
      centroid: 0.28,
      flux: 0.03,
      mid: 0.42,
      treble: 0.16
    })).toBe('soft')
    expect(detectSongMood({
      bass: 0.52,
      beat: 0.42,
      centroid: 0.38,
      flux: 0.12,
      mid: 0.56,
      treble: 0.28
    })).toBe('pop')
    expect(detectSongMood({
      bass: 0.82,
      beat: 0.84,
      centroid: 0.6,
      flux: 0.3,
      mid: 0.62,
      treble: 0.72
    })).toBe('strong')
  })

  it('does not fabricate beat constellations for weak sustained audio from elapsed time alone', () => {
    let state = { ...createMusicAuraEngineState(), previousBass: 0.34, previousFlux: 0.04 }

    for (let frame = 0; frame < 80; frame += 1) {
      state = advanceMusicAuraEngine(state, {
        bass: 0.34 + Math.sin(frame * 0.18) * 0.04,
        beat: 0.1,
        centroid: 0.34,
        flux: 0.04,
        mid: 0.52,
        treble: 0.18
      }, 0.05, true)
    }

    expect(state.beatCursor).toBe(0)
    expect(state.pulses).toHaveLength(0)
    expect(state.coreFlash).toBe(0)
  })

  it('keeps silent or unavailable frequency data free of artificial beats over time', () => {
    let state = createMusicAuraEngineState()
    for (let frame = 0; frame < 1200; frame++) {
      state = advanceMusicAuraEngine(state, { bass: 0, mid: 0, treble: 0, beat: 0, flux: 0, centroid: 0.32 }, 0.05, true)
    }
    expect(state.beatCursor).toBe(0)
    expect(state.pulses).toHaveLength(0)
    expect(state.coreFlash).toBe(0)
  })

  it('uses shorter stronger flashes for pop and strong rhythm instead of one fixed blink', () => {
    const popState = advanceMusicAuraEngine(createMusicAuraEngineState(), {
      bass: 0.58,
      beat: 0.5,
      centroid: 0.4,
      flux: 0.14,
      mid: 0.58,
      treble: 0.3
    }, 0.05, true)
    const strongState = advanceMusicAuraEngine(createMusicAuraEngineState(), {
      bass: 0.9,
      beat: 0.94,
      centroid: 0.62,
      flux: 0.34,
      mid: 0.72,
      treble: 0.8
    }, 0.05, true)
    const popPulse = popState.pulses[0]
    const strongPulse = strongState.pulses[0]

    expect(popPulse?.mood).toBe('pop')
    expect(strongPulse?.mood).toBe('strong')
    expect(popPulse?.strength).toBeGreaterThan(0.78)
    expect(strongPulse?.strength).toBeGreaterThan(popPulse?.strength ?? 0)
    expect(strongPulse?.attackSeconds).toBeLessThan(popPulse?.attackSeconds ?? 1)
    expect(strongPulse?.releaseSeconds).toBeLessThan(popPulse?.releaseSeconds ?? 1)
  })

  it('makes the center reactor visibly brighter on a strong beat without relying on whole-sphere motion', () => {
    const idleReactor = calculateCoreReactor(createMusicAuraEngineState(), {
      bass: 0.12,
      beat: 0,
      centroid: 0.32,
      flux: 0,
      mid: 0.14,
      treble: 0.1
    })
    const activeState = advanceMusicAuraEngine(createMusicAuraEngineState(), {
      bass: 0.84,
      beat: 0.92,
      centroid: 0.4,
      flux: 0.28,
      mid: 0.5,
      treble: 0.24
    }, 0.05, true)
    const activeReactor = calculateCoreReactor(activeState, {
      bass: 0.84,
      beat: 0.92,
      centroid: 0.4,
      flux: 0.28,
      mid: 0.5,
      treble: 0.24
    })

    expect(activeState.pulses.length).toBe(1)
    expect(activeReactor.opacity).toBeGreaterThan(idleReactor.opacity * 2)
    expect(activeReactor.opacity).toBeGreaterThan(0.34)
    expect(activeReactor.scale).toBeGreaterThan(0.9)
  })

  it('stops creating beats while paused and lets existing constellations fade out', () => {
    let state = advanceMusicAuraEngine(createMusicAuraEngineState(), {
      bass: 0.8,
      beat: 0.9,
      centroid: 0.38,
      flux: 0.3,
      mid: 0.45,
      treble: 0.2
    }, 0.05, true)

    for (let frame = 0; frame < 40; frame += 1) {
      state = advanceMusicAuraEngine(state, {
        bass: 0.8,
        beat: 0.9,
        centroid: 0.38,
        flux: 0.3,
        mid: 0.45,
        treble: 0.2
      }, 0.05, false)
    }

    expect(state.pulses).toHaveLength(0)
    expect(state.coreFlash).toBeLessThan(0.06)
    expect(state.coreEnergy).toBeLessThan(0.08)
  })
})
