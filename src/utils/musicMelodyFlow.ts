import type { MusicAudioBands } from '@/types/app'

export type MusicMelodyFlowState = {
  angle: number
  contour: number
  direction: number
  glow: number
  lift: number
  motion: number
  previousContour: number
  sparkle: number
  width: number
}

export type MelodyRibbonLightInput = {
  directionX: number
  directionY: number
  directionZ: number
  layer: number
  phase: number
  radius: number
  seed: number
  state: MusicMelodyFlowState
}

export type MelodyRibbonLight = {
  melodyMilk: number
  melodyTeal: number
  ribbonLight: number
  ribbonSpark: number
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function lerp(current: number, target: number, amount: number): number {
  return current + (target - current) * amount
}

function decay(value: number, deltaSeconds: number, halfLifeSeconds: number): number {
  return value * Math.pow(0.5, deltaSeconds / halfLifeSeconds)
}

function smoothstep(value: number, edge0: number, edge1: number): number {
  const normalized = clamp01((value - edge0) / Math.max(0.0001, edge1 - edge0))

  return normalized * normalized * (3 - 2 * normalized)
}

function calculateMelodyContour(bands: MusicAudioBands): number {
  const centroid = clamp01(bands.centroid ?? 0.32)
  const mid = clamp01(bands.mid)
  const treble = clamp01(bands.treble)

  return clamp01(centroid * 0.58 + mid * 0.28 + treble * 0.14)
}

export function createMusicMelodyFlowState(): MusicMelodyFlowState {
  return {
    angle: 0,
    contour: 0.36,
    direction: 0,
    glow: 0,
    lift: 0,
    motion: 0,
    previousContour: 0.36,
    sparkle: 0,
    width: 0.3
  }
}

export function advanceMusicMelodyFlow(
  state: MusicMelodyFlowState,
  bands: MusicAudioBands,
  deltaSeconds: number,
  isPlaying: boolean
): MusicMelodyFlowState {
  const safeDelta = clamp(deltaSeconds, 0.001, 0.08)

  if (!isPlaying) {
    return {
      ...state,
      direction: lerp(state.direction, 0, 0.12),
      glow: decay(state.glow, safeDelta, 0.26),
      lift: lerp(state.lift, 0, 0.1),
      motion: decay(state.motion, safeDelta, 0.18),
      sparkle: decay(state.sparkle, safeDelta, 0.14),
      width: lerp(state.width, 0.3, 0.08)
    }
  }

  const contour = calculateMelodyContour(bands)
  const contourDelta = contour - state.previousContour
  const flux = clamp01(bands.flux ?? 0)
  const beat = clamp01(bands.beat ?? 0)
  const mid = clamp01(bands.mid)
  const treble = clamp01(bands.treble)
  const motionTarget = clamp01(Math.abs(contourDelta) * 7.2 + flux * 0.78 + Math.max(0, beat - 0.28) * 0.32)
  const directionTarget = clamp(contourDelta * 6.4 + (treble - mid) * 0.24, -1, 1)
  const liftTarget = clamp((contour - 0.46) * 1.52 + directionTarget * 0.2, -0.72, 0.72)
  const glowTarget = clamp01(0.18 + mid * 0.52 + treble * 0.18 + motionTarget * 0.38)
  const widthTarget = clamp(0.34 - motionTarget * 0.11 + mid * 0.035, 0.18, 0.36)
  const nextMotion = Math.max(decay(state.motion, safeDelta, 0.32), motionTarget)

  return {
    angle: state.angle + safeDelta * (0.42 + mid * 0.78 + treble * 0.28) + directionTarget * 0.025,
    contour,
    direction: lerp(state.direction, directionTarget, 0.62),
    glow: lerp(state.glow, glowTarget, 0.18),
    lift: lerp(state.lift, liftTarget, directionTarget > state.direction ? 0.46 : 0.38),
    motion: nextMotion,
    previousContour: contour,
    sparkle: Math.max(decay(state.sparkle, safeDelta, 0.2), smoothstep(motionTarget, 0.18, 0.72)),
    width: lerp(state.width, widthTarget, 0.16)
  }
}

export function calculateMelodyRibbonLight(input: MelodyRibbonLightInput): MelodyRibbonLight {
  const { state } = input
  const ribbonX = Math.cos(state.angle)
  const ribbonZ = Math.sin(state.angle)
  const acrossX = Math.cos(state.angle + Math.PI / 2)
  const acrossZ = Math.sin(state.angle + Math.PI / 2)
  const along = input.directionX * ribbonX + input.directionZ * ribbonZ
  const across = input.directionX * acrossX + input.directionZ * acrossZ
  const verticalDistance = Math.abs(input.directionY - state.lift)
  const ribbonDistance = Math.sqrt(verticalDistance * verticalDistance * 1.2 + across * across * 0.34)
  const ribbonCore = Math.exp(-(ribbonDistance * ribbonDistance) / Math.max(0.018, state.width * state.width))
  const interiorMask = Math.exp(-Math.pow(input.radius - 0.52, 2) / 0.16)
  const travelingLight = 0.72 + 0.28 * Math.sin(input.phase * 1.9 + state.angle * 2.4 + along * 4.2)
  const localSparkGate = input.seed > 0.76 ? 1 : 0.22
  const ribbonSpark = ribbonCore * interiorMask * state.sparkle * localSparkGate * (0.7 + input.seed * 0.3)
  const layerWeight = input.layer === 2 ? 1.2 : input.layer === 1 ? 1.82 : 0.28
  const ribbonLight = ribbonCore * interiorMask * state.glow * travelingLight * layerWeight

  return {
    melodyMilk: clamp01(ribbonLight * 0.46 + ribbonSpark * 0.54),
    melodyTeal: clamp01(ribbonLight * 0.24 + Math.max(0, state.direction) * 0.16),
    ribbonLight,
    ribbonSpark
  }
}
