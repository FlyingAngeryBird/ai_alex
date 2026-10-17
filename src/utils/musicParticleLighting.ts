export const MUSIC_PARTICLE_LAYER_SHELL = 0
export const MUSIC_PARTICLE_LAYER_CLOUD = 1
export const MUSIC_PARTICLE_LAYER_CORE = 2
export const MUSIC_LAYERED_LIGHT_CEILING = 1.18

export type MusicParticleLayer =
  | typeof MUSIC_PARTICLE_LAYER_SHELL
  | typeof MUSIC_PARTICLE_LAYER_CLOUD
  | typeof MUSIC_PARTICLE_LAYER_CORE

export type LayeredMusicLightInput = {
  bass: number
  cloudAfterglow: number
  innerBeam: number
  layer: MusicParticleLayer | number
  melodyRibbon: number
  mid: number
  radius: number
  resonanceWave: number
  treble: number
  trebleAfterglow: number
  trebleSpark: number
  visualBeatRelease: number
}

export type LayeredMusicLight = {
  cloudMask: number
  coreMask: number
  layeredBeatLight: number
  layeredInternalLight: number
  layeredMelodyLight: number
  layeredTrebleLight: number
  shellMask: number
}

export type MusicAuraMood = 'soft' | 'pop' | 'strong'

export type MusicAuraPulse = {
  age: number
  angle: number
  attackSeconds?: number
  group: number
  groups?: number[]
  holdSeconds?: number
  mood?: MusicAuraMood
  radiusEnd?: number
  radiusStart?: number
  releaseSeconds?: number
  strength: number
  type: 'beat' | 'downbeat'
}

export type MusicAuraPulseTriggerInput = {
  beat: number
  beatGate: number
  beatTravel: number
  flux: number
  onsetPulse: number
}

export type MusicAuraPulseTrigger = {
  shouldTrigger: boolean
  strength: number
}

export type AuraParticleLightInput = {
  bass: number
  cloudAfterglow: number
  directionX: number
  directionY: number
  directionZ: number
  group: number
  innerBeam: number
  layer: MusicParticleLayer | number
  melodyPhase: number
  mid: number
  phase: number
  pulses: MusicAuraPulse[]
  radius: number
  seed: number
  treble: number
  trebleAfterglow: number
  visualBeatRelease: number
  warmthSeed: number
}

export type AuraParticleLight = LayeredMusicLight & {
  auraBloom: number
  auraInternalLight: number
  auraMelodyLight: number
  auraMilkMix: number
  auraPulseLight: number
  auraTealMix: number
  auraTrebleLight: number
  auraWarmth: number
  melodyRibbon: number
  trebleSpark: number
}

function smoothstep(value: number, edge0: number, edge1: number): number {
  if (edge0 === edge1) {
    return value < edge0 ? 0 : 1
  }

  const x = clamp01((value - edge0) / (edge1 - edge0))
  return x * x * (3 - 2 * x)
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function pulseEnvelope(pulse: MusicAuraPulse): number {
  const attackSeconds = pulse.attackSeconds ?? (pulse.type === 'downbeat' ? 0.07 : 0.09)
  const holdSeconds = pulse.holdSeconds ?? 0.05
  const releaseSeconds = pulse.releaseSeconds ?? (pulse.type === 'downbeat' ? 0.98 : 0.9)
  const holdEnd = attackSeconds + holdSeconds
  const end = holdEnd + releaseSeconds

  if (pulse.age <= attackSeconds) {
    return smoothstep(pulse.age, 0, attackSeconds)
  }

  if (pulse.age <= holdEnd) {
    return 1
  }

  if (pulse.age >= end) {
    return 0
  }

  const release = 1 - smoothstep(pulse.age, holdEnd, end)
  return release * release * (3 - 2 * release)
}

function pulseProfile(pulse: MusicAuraPulse): {
  angularPower: number
  intensity: number
  secondaryGroup: number
  spillGroup: number
  waveWidth: number
} {
  if (pulse.mood === 'strong') {
    return {
      angularPower: 2.8,
      intensity: 1.82,
      secondaryGroup: 0.34,
      spillGroup: 0.006,
      waveWidth: 0.034
    }
  }

  if (pulse.mood === 'pop') {
    return {
      angularPower: 2.05,
      intensity: 1.46,
      secondaryGroup: 0.46,
      spillGroup: 0.008,
      waveWidth: 0.046
    }
  }

  return {
    angularPower: 1.35,
    intensity: 0.96,
    secondaryGroup: 0.58,
    spillGroup: 0.026,
    waveWidth: 0.086
  }
}

export function calculateMusicAuraPulseTrigger(input: MusicAuraPulseTriggerInput): MusicAuraPulseTrigger {
  const rhythmicContrast = Math.max(
    input.onsetPulse,
    input.flux * 2.1,
    Math.max(0, input.beat - 0.1) * 0.95,
    input.beatGate * 0.78
  )
  const shouldTrigger = input.beatTravel >= 0.18 && rhythmicContrast >= 0.3

  return {
    shouldTrigger,
    strength: clamp01(rhythmicContrast * 1.08)
  }
}

export function calculateLayeredMusicLight(input: LayeredMusicLightInput): LayeredMusicLight {
  const coreMask =
    Math.exp(-Math.pow(input.radius - 0.28, 2) / 0.045) *
    (input.layer === MUSIC_PARTICLE_LAYER_CORE ? 1.12 : input.layer === MUSIC_PARTICLE_LAYER_CLOUD ? 0.46 : 0.08)
  const cloudMask =
    Math.exp(-Math.pow(input.radius - 0.56, 2) / 0.11) *
    (input.layer === MUSIC_PARTICLE_LAYER_CLOUD ? 1.08 : input.layer === MUSIC_PARTICLE_LAYER_CORE ? 0.34 : 0.18)
  const shellMask =
    smoothstep(input.radius, 0.72, 1) *
    (input.layer === MUSIC_PARTICLE_LAYER_SHELL ? 1 : 0.22)
  const layeredBeatLight =
    coreMask *
    (input.visualBeatRelease * 0.7 + input.resonanceWave * 0.42 + input.bass * 0.26)
  const layeredMelodyLight =
    cloudMask *
    (input.cloudAfterglow * 0.76 + input.melodyRibbon * 0.48 + input.innerBeam * 0.28 + input.mid * 0.12)
  const layeredTrebleLight =
    shellMask *
    (input.trebleSpark * 1.2 + input.trebleAfterglow * 0.28 + input.treble * 0.08)

  return {
    cloudMask,
    coreMask,
    layeredBeatLight,
    layeredInternalLight: Math.min(
      MUSIC_LAYERED_LIGHT_CEILING,
      layeredBeatLight + layeredMelodyLight + layeredTrebleLight
    ),
    layeredMelodyLight,
    layeredTrebleLight,
    shellMask
  }
}

export function calculateAuraParticleLight(input: AuraParticleLightInput): AuraParticleLight {
  const melodyCarrier = Math.sin(
    input.melodyPhase * 2.1 +
    input.directionY * 5.2 +
    input.directionX * 1.8 +
    input.directionZ * 1.1 +
    input.phase * 0.35
  )
  const melodyRibbon = smoothstep((melodyCarrier + 1) / 2, 0.42, 0.96)
  const trebleSpark = input.seed > 0.88
    ? input.trebleAfterglow * (0.4 + input.seed * 0.35) + input.treble * 0.12
    : input.trebleAfterglow * 0.035
  const particleAngle = Math.atan2(input.directionZ, input.directionX)
  const auraPulseLight = input.pulses.reduce((total, pulse) => {
    const envelope = pulseEnvelope(pulse)
    if (envelope <= 0) {
      return total
    }

    const profile = pulseProfile(pulse)
    const attackSeconds = pulse.attackSeconds ?? (pulse.type === 'downbeat' ? 0.07 : 0.09)
    const holdSeconds = pulse.holdSeconds ?? 0.05
    const releaseSeconds = pulse.releaseSeconds ?? (pulse.type === 'downbeat' ? 0.58 : 0.48)
    const pulseDuration = attackSeconds + holdSeconds + releaseSeconds
    const progress = clamp01(pulse.age / Math.max(0.001, pulseDuration))
    const radiusStart = pulse.radiusStart ?? 0.18
    const radiusEnd = pulse.radiusEnd ?? 0.78
    const waveRadius = radiusStart + (radiusEnd - radiusStart) * progress
    const wave = Math.exp(-Math.pow(input.radius - waveRadius, 2) / profile.waveWidth)
    const groups = pulse.groups ?? [pulse.group, (pulse.group + 1) % 16, (pulse.group + 15) % 16]
    const groupIndex = groups.indexOf(input.group)
    const groupHit = groupIndex === 0 ? 1 : groupIndex > 0 ? profile.secondaryGroup : profile.spillGroup
    const angularHit = Math.max(0, Math.cos(particleAngle - pulse.angle))
    const livingSpark =
      pulse.mood === 'soft'
        ? 0.82 + 0.18 * Math.sin(input.phase * 2.4 + pulse.age * 7.5)
        : 0.74 + 0.26 * Math.sin(input.phase * 5.6 + pulse.age * (pulse.mood === 'strong' ? 22 : 15))
    const layerWeight = input.layer === MUSIC_PARTICLE_LAYER_CORE
      ? 1.12
      : input.layer === MUSIC_PARTICLE_LAYER_CLOUD
        ? 0.78
        : pulse.mood === 'strong' ? 0.26 : 0.18

    return total +
      envelope *
      wave *
      groupHit *
      Math.pow(angularHit, profile.angularPower) *
      livingSpark *
      layerWeight *
      pulse.strength *
      profile.intensity
  }, 0)
  const layered = calculateLayeredMusicLight({
    bass: input.bass,
    cloudAfterglow: input.cloudAfterglow,
    innerBeam: input.innerBeam,
    layer: input.layer,
    melodyRibbon,
    mid: input.mid,
    radius: input.radius,
    resonanceWave: auraPulseLight * 0.56 + input.visualBeatRelease * 0.18,
    treble: input.treble,
    trebleAfterglow: input.trebleAfterglow,
    trebleSpark,
    visualBeatRelease: Math.max(input.visualBeatRelease, auraPulseLight)
  })
  const auraMelodyLight =
    layered.layeredMelodyLight +
    layered.cloudMask * (melodyRibbon * input.mid * 0.42 + input.cloudAfterglow * 0.2)
  const auraTrebleLight =
    layered.layeredTrebleLight +
    layered.shellMask * trebleSpark * 0.84
  const auraInternalLight = Math.min(
    MUSIC_LAYERED_LIGHT_CEILING,
    layered.layeredInternalLight + auraPulseLight * 0.72 + auraMelodyLight * 0.22 + auraTrebleLight * 0.16
  )
  const auraBloom = clamp01(auraPulseLight * 0.36 + auraTrebleLight * 0.12 + layered.layeredBeatLight * 0.08)

  return {
    ...layered,
    auraBloom,
    auraInternalLight,
    auraMelodyLight,
    auraMilkMix: clamp01(auraInternalLight * 0.48 + auraPulseLight * 0.32),
    auraPulseLight,
    auraTealMix: clamp01((1 - input.warmthSeed) * 0.18 + input.mid * 0.22 + auraMelodyLight * 0.18),
    auraTrebleLight,
    auraWarmth: clamp01(input.warmthSeed * 0.12 + input.bass * 0.22 + auraPulseLight * 0.42),
    melodyRibbon,
    trebleSpark
  }
}
