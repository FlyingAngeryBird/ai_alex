import type { MusicAudioBands } from '@/types/app'
import type { MusicAuraMood, MusicAuraPulse } from './musicParticleLighting'

const TAU = Math.PI * 2
const MIN_BEAT_INTERVAL_SECONDS = 0.28
const MAX_BEAT_INTERVAL_SECONDS = 1.05
const FALLBACK_BEAT_INTERVAL_SECONDS = 0.72
const MAX_PULSES = 18

type MusicAuraMoodProfile = {
  attackSeconds: number
  energyScale: number
  floorStrength: number
  holdSeconds: number
  minIntervalSeconds: number
  radiusEnd: number
  radiusStart: number
  releaseSeconds: number
  targetIntervalSeconds: number
  triggerThreshold: number
}

export type MusicAuraEngineState = {
  beatCursor: number
  beatIntervalSeconds: number
  beatTimerSeconds: number
  coreEnergy: number
  coreFlash: number
  melodyPhase: number
  mood: MusicAuraMood
  previousBass: number
  previousFlux: number
  pulses: MusicAuraPulse[]
}

export type CoreReactor = {
  opacity: number
  scale: number
  warmth: number
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function decay(value: number, deltaSeconds: number, halfLifeSeconds: number): number {
  return value * Math.pow(0.5, deltaSeconds / halfLifeSeconds)
}

const MOOD_PROFILES: Record<MusicAuraMood, MusicAuraMoodProfile> = {
  soft: {
    attackSeconds: 0.14,
    energyScale: 0.72,
    floorStrength: 0.5,
    holdSeconds: 0.08,
    minIntervalSeconds: 0.64,
    radiusEnd: 0.68,
    radiusStart: 0.2,
    releaseSeconds: 0.96,
    targetIntervalSeconds: 0.82,
    triggerThreshold: 0.62
  },
  pop: {
    attackSeconds: 0.08,
    energyScale: 0.98,
    floorStrength: 0.58,
    holdSeconds: 0.06,
    minIntervalSeconds: 0.34,
    radiusEnd: 0.8,
    radiusStart: 0.18,
    releaseSeconds: 0.52,
    targetIntervalSeconds: 0.52,
    triggerThreshold: 0.36
  },
  strong: {
    attackSeconds: 0.045,
    energyScale: 1.22,
    floorStrength: 0.68,
    holdSeconds: 0.04,
    minIntervalSeconds: 0.28,
    radiusEnd: 0.86,
    radiusStart: 0.16,
    releaseSeconds: 0.34,
    targetIntervalSeconds: 0.38,
    triggerThreshold: 0.28
  }
}

export function detectSongMood(bands: MusicAudioBands): MusicAuraMood {
  const beat = bands.beat ?? 0
  const flux = bands.flux ?? 0
  const centroid = bands.centroid ?? 0.32
  const impact =
    beat * 0.42 +
    bands.bass * 0.28 +
    flux * 0.22 +
    bands.treble * 0.08 +
    Math.max(0, centroid - 0.42) * 0.12

  if (impact >= 0.66 || (beat >= 0.72 && bands.bass >= 0.68) || (flux >= 0.28 && bands.treble >= 0.62)) {
    return 'strong'
  }

  if (impact >= 0.3 || beat >= 0.28 || flux >= 0.1) {
    return 'pop'
  }

  return 'soft'
}

export function createMusicAuraEngineState(): MusicAuraEngineState {
  return {
    beatCursor: 0,
    beatIntervalSeconds: FALLBACK_BEAT_INTERVAL_SECONDS,
    beatTimerSeconds: FALLBACK_BEAT_INTERVAL_SECONDS,
    coreEnergy: 0,
    coreFlash: 0,
    melodyPhase: 0,
    mood: 'soft',
    previousBass: 0,
    previousFlux: 0,
    pulses: []
  }
}

function createPulse(
  state: MusicAuraEngineState,
  strength: number,
  mood: MusicAuraMood,
  profile: MusicAuraMoodProfile
): MusicAuraPulse {
  const mainGroup = state.beatCursor % 24
  const secondGroup = (mainGroup + 7 + (state.beatCursor % 3)) % 24
  const thirdGroup = (mainGroup + 17) % 24
  const type: MusicAuraPulse['type'] = state.beatCursor % 4 === 0 ? 'downbeat' : 'beat'
  const downbeatLift = type === 'downbeat' ? 1.08 : 0.94

  return {
    age: 0,
    angle: (state.beatCursor * 2.399963 + state.melodyPhase * 0.68) % TAU,
    attackSeconds: profile.attackSeconds,
    group: mainGroup,
    groups: [mainGroup, secondGroup, thirdGroup],
    holdSeconds: profile.holdSeconds,
    mood,
    radiusEnd: profile.radiusEnd,
    radiusStart: profile.radiusStart,
    releaseSeconds: profile.releaseSeconds,
    strength: clamp(strength, 0, 1.28) * downbeatLift,
    type
  }
}

function advancePulses(pulses: MusicAuraPulse[], deltaSeconds: number, isPlaying: boolean): MusicAuraPulse[] {
  const nextPulses = pulses
    .map((pulse) => ({
      ...pulse,
      age: pulse.age + deltaSeconds
    }))
    .filter((pulse) => pulse.age <= (isPlaying ? 2.2 : 0.88))

  if (nextPulses.length > MAX_PULSES) {
    return nextPulses.slice(nextPulses.length - MAX_PULSES)
  }

  return nextPulses
}

function calculateRhythmEnergy(bands: MusicAudioBands, previousBass: number, previousFlux: number): number {
  const bassRise = Math.max(0, bands.bass - previousBass)
  const fluxRise = Math.max(0, (bands.flux ?? 0) - previousFlux)

  return clamp01(
    (bands.beat ?? 0) * 0.72 +
    bands.bass * 0.24 +
    bassRise * 1.7 +
    (bands.flux ?? 0) * 1.25 +
    fluxRise * 1.8
  )
}

function shouldTriggerBeat(
  state: MusicAuraEngineState,
  rhythmEnergy: number,
  isPlaying: boolean,
  profile: MusicAuraMoodProfile
): boolean {
  if (!isPlaying || state.beatTimerSeconds < profile.minIntervalSeconds) {
    return false
  }

  return rhythmEnergy >= profile.triggerThreshold || state.beatTimerSeconds >= state.beatIntervalSeconds
}

export function advanceMusicAuraEngine(
  state: MusicAuraEngineState,
  bands: MusicAudioBands,
  deltaSeconds: number,
  isPlaying: boolean
): MusicAuraEngineState {
  const safeDelta = clamp(deltaSeconds, 0.001, 0.08)
  const rhythmEnergy = calculateRhythmEnergy(bands, state.previousBass, state.previousFlux)
  const mood = detectSongMood(bands)
  const profile = MOOD_PROFILES[mood]
  const nextState: MusicAuraEngineState = {
    ...state,
    beatTimerSeconds: state.beatTimerSeconds + safeDelta,
    coreEnergy: decay(state.coreEnergy, safeDelta, isPlaying ? 0.72 : 0.28),
    coreFlash: decay(state.coreFlash, safeDelta, isPlaying ? 0.22 : 0.16),
    melodyPhase: state.melodyPhase + safeDelta * (0.22 + bands.mid * 0.54 + (bands.centroid ?? 0.32) * 0.18),
    mood,
    previousBass: bands.bass,
    previousFlux: bands.flux ?? 0,
    pulses: advancePulses(state.pulses, safeDelta, isPlaying)
  }

  if (!isPlaying) {
    return nextState
  }

  nextState.coreEnergy = Math.max(nextState.coreEnergy, 0.12 + bands.bass * 0.34 + bands.mid * 0.18)
  nextState.beatIntervalSeconds = clamp(
    nextState.beatIntervalSeconds * 0.86 + profile.targetIntervalSeconds * 0.14,
    MIN_BEAT_INTERVAL_SECONDS,
    MAX_BEAT_INTERVAL_SECONDS
  )

  if (shouldTriggerBeat(nextState, rhythmEnergy, true, profile)) {
    const interval = nextState.beatTimerSeconds
    const strength = Math.max(
      profile.floorStrength,
      rhythmEnergy * profile.energyScale,
      bands.bass * 0.44 + bands.mid * 0.22 + (bands.beat ?? 0) * 0.42
    )

    nextState.pulses = [...nextState.pulses, createPulse(nextState, strength, mood, profile)].slice(-MAX_PULSES)
    nextState.beatCursor += 1
    nextState.beatIntervalSeconds = clamp(
      interval * 0.36 + profile.targetIntervalSeconds * 0.38 + nextState.beatIntervalSeconds * 0.26,
      MIN_BEAT_INTERVAL_SECONDS,
      MAX_BEAT_INTERVAL_SECONDS
    )
    nextState.beatTimerSeconds = 0
    nextState.coreFlash = Math.max(nextState.coreFlash, 0.42 + strength * 0.46)
    nextState.coreEnergy = Math.max(nextState.coreEnergy, 0.34 + strength * 0.32)
  }

  return nextState
}

export function calculateCoreReactor(state: MusicAuraEngineState, bands: MusicAudioBands): CoreReactor {
  const bassLift = clamp01(bands.bass * 0.18 + (bands.beat ?? 0) * 0.12)
  const flash = clamp01(state.coreFlash)
  const energy = clamp01(state.coreEnergy)

  return {
    opacity: clamp(0.16 + energy * 0.18 + flash * 0.28 + bassLift, 0.14, 0.56),
    scale: clamp(0.72 + energy * 0.18 + flash * 0.17, 0.7, 1.08),
    warmth: clamp01(0.54 + bands.bass * 0.24 + flash * 0.18)
  }
}
