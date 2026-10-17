import { describe, expect, it } from 'vitest'
import {
  calculateAuraParticleLight,
  calculateLayeredMusicLight,
  calculateMusicAuraPulseTrigger,
  type MusicAuraPulse,
  MUSIC_PARTICLE_LAYER_CLOUD,
  MUSIC_PARTICLE_LAYER_CORE,
  MUSIC_PARTICLE_LAYER_SHELL
} from '../src/utils/musicParticleLighting'

describe('music particle lighting', () => {
  it('routes bass and beat energy into the inner core instead of the whole sphere', () => {
    const coreLight = calculateLayeredMusicLight({
      bass: 0.82,
      cloudAfterglow: 0.08,
      innerBeam: 0.04,
      layer: MUSIC_PARTICLE_LAYER_CORE,
      melodyRibbon: 0.02,
      mid: 0.12,
      radius: 0.28,
      resonanceWave: 0.72,
      treble: 0.08,
      trebleAfterglow: 0.02,
      trebleSpark: 0.01,
      visualBeatRelease: 0.84
    })
    const shellLight = calculateLayeredMusicLight({
      bass: 0.82,
      cloudAfterglow: 0.08,
      innerBeam: 0.04,
      layer: MUSIC_PARTICLE_LAYER_SHELL,
      melodyRibbon: 0.02,
      mid: 0.12,
      radius: 0.92,
      resonanceWave: 0.72,
      treble: 0.08,
      trebleAfterglow: 0.02,
      trebleSpark: 0.01,
      visualBeatRelease: 0.84
    })

    expect(coreLight.layeredBeatLight).toBeGreaterThan(coreLight.layeredMelodyLight)
    expect(coreLight.layeredBeatLight).toBeGreaterThan(coreLight.layeredTrebleLight)
    expect(coreLight.layeredInternalLight).toBeGreaterThan(shellLight.layeredInternalLight * 2.5)
  })

  it('routes midrange melody into the cloud layer as a soft internal flow', () => {
    const cloudLight = calculateLayeredMusicLight({
      bass: 0.16,
      cloudAfterglow: 0.62,
      innerBeam: 0.38,
      layer: MUSIC_PARTICLE_LAYER_CLOUD,
      melodyRibbon: 0.72,
      mid: 0.76,
      radius: 0.56,
      resonanceWave: 0.18,
      treble: 0.12,
      trebleAfterglow: 0.03,
      trebleSpark: 0.01,
      visualBeatRelease: 0.16
    })

    expect(cloudLight.layeredMelodyLight).toBeGreaterThan(cloudLight.layeredBeatLight)
    expect(cloudLight.layeredMelodyLight).toBeGreaterThan(cloudLight.layeredTrebleLight)
    expect(cloudLight.cloudMask).toBeGreaterThan(cloudLight.coreMask)
    expect(cloudLight.cloudMask).toBeGreaterThan(cloudLight.shellMask)
  })

  it('routes treble into restrained shell sparks and caps perceptual brightness', () => {
    const shellLight = calculateLayeredMusicLight({
      bass: 0.12,
      cloudAfterglow: 0.08,
      innerBeam: 0.04,
      layer: MUSIC_PARTICLE_LAYER_SHELL,
      melodyRibbon: 0.04,
      mid: 0.18,
      radius: 0.96,
      resonanceWave: 0.12,
      treble: 0.92,
      trebleAfterglow: 0.54,
      trebleSpark: 0.48,
      visualBeatRelease: 0.12
    })

    expect(shellLight.layeredTrebleLight).toBeGreaterThan(shellLight.layeredBeatLight)
    expect(shellLight.layeredTrebleLight).toBeGreaterThan(shellLight.layeredMelodyLight)
    expect(shellLight.shellMask).toBeGreaterThan(shellLight.coreMask)
    expect(shellLight.layeredInternalLight).toBeLessThanOrEqual(1.18)
  })

  it('turns a beat into a selected inner constellation instead of lighting every particle equally', () => {
    const pulses: MusicAuraPulse[] = [
      {
        age: 0.08,
        angle: 0,
        group: 3,
        strength: 0.92,
        type: 'downbeat'
      }
    ]

    const selected = calculateAuraParticleLight({
      bass: 0.78,
      cloudAfterglow: 0.12,
      directionX: 1,
      directionY: 0.05,
      directionZ: 0,
      group: 3,
      innerBeam: 0.08,
      layer: MUSIC_PARTICLE_LAYER_CORE,
      melodyPhase: 1.2,
      mid: 0.22,
      phase: 0.4,
      pulses,
      radius: 0.28,
      seed: 0.42,
      treble: 0.1,
      trebleAfterglow: 0.02,
      visualBeatRelease: 0.84,
      warmthSeed: 0.5
    })
    const unselected = calculateAuraParticleLight({
      bass: 0.78,
      cloudAfterglow: 0.12,
      directionX: -0.2,
      directionY: 0.05,
      directionZ: 0.98,
      group: 9,
      innerBeam: 0.08,
      layer: MUSIC_PARTICLE_LAYER_CORE,
      melodyPhase: 1.2,
      mid: 0.22,
      phase: 0.4,
      pulses,
      radius: 0.28,
      seed: 0.42,
      treble: 0.1,
      trebleAfterglow: 0.02,
      visualBeatRelease: 0.84,
      warmthSeed: 0.5
    })

    expect(selected.auraPulseLight).toBeGreaterThan(unselected.auraPulseLight * 4)
    expect(selected.auraBloom).toBeGreaterThan(unselected.auraBloom)
    expect(selected.auraMilkMix).toBeGreaterThan(unselected.auraMilkMix)
  })

  it('lets pulse light fade with age so the rhythm has afterglow instead of a constant lamp', () => {
    const youngPulse: MusicAuraPulse = {
      age: 0.06,
      angle: 0.1,
      group: 4,
      strength: 1,
      type: 'beat'
    }
    const oldPulse: MusicAuraPulse = {
      ...youngPulse,
      age: 0.92
    }
    const baseParticle = {
      bass: 0.72,
      cloudAfterglow: 0.08,
      directionX: 0.98,
      directionY: 0.1,
      directionZ: 0.08,
      group: 4,
      innerBeam: 0.05,
      layer: MUSIC_PARTICLE_LAYER_CORE,
      melodyPhase: 0.8,
      mid: 0.18,
      phase: 0.2,
      radius: 0.3,
      seed: 0.4,
      treble: 0.08,
      trebleAfterglow: 0.02,
      visualBeatRelease: 0.72,
      warmthSeed: 0.4
    }

    const young = calculateAuraParticleLight({
      ...baseParticle,
      pulses: [youngPulse]
    })
    const old = calculateAuraParticleLight({
      ...baseParticle,
      pulses: [oldPulse]
    })

    expect(young.auraPulseLight).toBeGreaterThan(old.auraPulseLight * 2.5)
    expect(old.auraPulseLight).toBeGreaterThan(0)
  })

  it('makes rhythm field hits clearly brighter than the calm particle floor', () => {
    const pulse: MusicAuraPulse = {
      age: 0.1,
      angle: 0,
      attackSeconds: 0.08,
      group: 5,
      groups: [5, 12, 22],
      holdSeconds: 0.06,
      mood: 'pop',
      radiusEnd: 0.78,
      radiusStart: 0.18,
      releaseSeconds: 0.52,
      strength: 1.05,
      type: 'beat'
    }
    const selected = calculateAuraParticleLight({
      bass: 0.58,
      cloudAfterglow: 0.12,
      directionX: 1,
      directionY: 0.04,
      directionZ: 0,
      group: 5,
      innerBeam: 0.04,
      layer: MUSIC_PARTICLE_LAYER_CORE,
      melodyPhase: 1,
      mid: 0.58,
      phase: 0.35,
      pulses: [pulse],
      radius: 0.28,
      seed: 0.5,
      treble: 0.3,
      trebleAfterglow: 0.04,
      visualBeatRelease: 0.36,
      warmthSeed: 0.45
    })
    const calmFloor = calculateAuraParticleLight({
      bass: 0.58,
      cloudAfterglow: 0.12,
      directionX: -0.38,
      directionY: 0.04,
      directionZ: 0.92,
      group: 18,
      innerBeam: 0.04,
      layer: MUSIC_PARTICLE_LAYER_CORE,
      melodyPhase: 1,
      mid: 0.58,
      phase: 0.35,
      pulses: [pulse],
      radius: 0.28,
      seed: 0.5,
      treble: 0.3,
      trebleAfterglow: 0.04,
      visualBeatRelease: 0.36,
      warmthSeed: 0.45
    })

    expect(selected.auraPulseLight).toBeGreaterThan(0.55)
    expect(selected.auraPulseLight).toBeGreaterThan(calmFloor.auraPulseLight * 8)
    expect(selected.auraBloom).toBeGreaterThan(calmFloor.auraBloom * 2)
  })

  it('keeps soft rhythm flashes lingering while strong rhythm flashes resolve quickly', () => {
    const basePulse: MusicAuraPulse = {
      age: 0.7,
      angle: 0,
      group: 7,
      groups: [7, 14, 23],
      radiusEnd: 0.74,
      radiusStart: 0.18,
      strength: 1,
      type: 'beat'
    }
    const baseParticle = {
      bass: 0.5,
      cloudAfterglow: 0.14,
      directionX: 1,
      directionY: 0.03,
      directionZ: 0,
      group: 7,
      innerBeam: 0.04,
      layer: MUSIC_PARTICLE_LAYER_CLOUD,
      melodyPhase: 1.1,
      mid: 0.52,
      phase: 0.2,
      radius: 0.57,
      seed: 0.46,
      treble: 0.24,
      trebleAfterglow: 0.04,
      visualBeatRelease: 0.3,
      warmthSeed: 0.48
    }
    const soft = calculateAuraParticleLight({
      ...baseParticle,
      pulses: [{
        ...basePulse,
        attackSeconds: 0.14,
        holdSeconds: 0.08,
        mood: 'soft',
        releaseSeconds: 0.96
      }]
    })
    const strong = calculateAuraParticleLight({
      ...baseParticle,
      pulses: [{
        ...basePulse,
        attackSeconds: 0.045,
        holdSeconds: 0.04,
        mood: 'strong',
        releaseSeconds: 0.34
      }]
    })

    expect(soft.auraPulseLight).toBeGreaterThan(0.08)
    expect(strong.auraPulseLight).toBeLessThan(soft.auraPulseLight * 0.5)
  })

  it('keeps melody as a flowing cloud while treble remains a sparse shell sparkle', () => {
    const cloud = calculateAuraParticleLight({
      bass: 0.18,
      cloudAfterglow: 0.62,
      directionX: 0.2,
      directionY: 0.8,
      directionZ: 0.2,
      group: 1,
      innerBeam: 0.36,
      layer: MUSIC_PARTICLE_LAYER_CLOUD,
      melodyPhase: 2.4,
      mid: 0.74,
      phase: 0.1,
      pulses: [],
      radius: 0.56,
      seed: 0.3,
      treble: 0.18,
      trebleAfterglow: 0.04,
      visualBeatRelease: 0.1,
      warmthSeed: 0.4
    })
    const shellInput = {
      bass: 0.16,
      cloudAfterglow: 0.08,
      directionX: 0.2,
      directionY: 0.1,
      directionZ: 0.94,
      group: 12,
      innerBeam: 0.04,
      layer: MUSIC_PARTICLE_LAYER_SHELL,
      melodyPhase: 2.4,
      mid: 0.2,
      phase: 0.1,
      pulses: [],
      radius: 0.96,
      seed: 0.94,
      treble: 0.88,
      trebleAfterglow: 0.5,
      visualBeatRelease: 0.08,
      warmthSeed: 0.3
    }
    const shell = calculateAuraParticleLight(shellInput)
    const dullShell = calculateAuraParticleLight({
      ...shellInput,
      seed: 0.3
    })

    expect(cloud.auraMelodyLight).toBeGreaterThan(cloud.auraTrebleLight)
    expect(shell.auraTrebleLight).toBeGreaterThan(shell.auraMelodyLight)
    expect(shell.auraTrebleLight).toBeGreaterThan(dullShell.auraTrebleLight * 2)
  })

  it('triggers an inner constellation from ordinary song rhythm instead of waiting for extreme peaks', () => {
    const trigger = calculateMusicAuraPulseTrigger({
      beat: 0.38,
      beatGate: 0.42,
      beatTravel: 0.24,
      flux: 0.09,
      onsetPulse: 0.16
    })

    expect(trigger.shouldTrigger).toBe(true)
    expect(trigger.strength).toBeGreaterThan(0.32)
  })

  it('keeps the aura calm when the audio signal has no real rhythmic contrast', () => {
    const trigger = calculateMusicAuraPulseTrigger({
      beat: 0.08,
      beatGate: 0.14,
      beatTravel: 0.7,
      flux: 0.02,
      onsetPulse: 0.04
    })

    expect(trigger.shouldTrigger).toBe(false)
    expect(trigger.strength).toBeLessThan(0.2)
  })
})
