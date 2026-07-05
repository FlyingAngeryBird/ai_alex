<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import type { MusicAudioBands, ParticleState } from '@/types/app'
import {
  calculateAuraParticleLight,
  MUSIC_PARTICLE_LAYER_CLOUD,
  MUSIC_PARTICLE_LAYER_CORE,
  MUSIC_PARTICLE_LAYER_SHELL
} from '@/utils/musicParticleLighting'
import {
  advanceMusicAuraEngine,
  calculateCoreReactor,
  createMusicAuraEngineState
} from '@/utils/musicAuraEngine'
import {
  advanceMusicMelodyFlow,
  calculateMelodyRibbonLight,
  createMusicMelodyFlowState
} from '@/utils/musicMelodyFlow'

const props = withDefaults(defineProps<{
  audioBands?: MusicAudioBands
  audioLevel: number
  state: ParticleState
}>(), {
  audioBands: () => ({
    bass: 0.14,
    beat: 0,
    centroid: 0.32,
    flux: 0,
    mid: 0.14,
    treble: 0.14
  })
})

type VisualConfig = {
  palette: THREE.Color[]
  opacity: number
  pointSize: number
  radius: number
  speed: number
  tightness: number
}

type MusicMotionState = {
  afterglowBands: number
  beatGate: number
  beatImpulse: number
  beatTravel: number
  bodyBreath: number
  glowBloom: number
  hazeGlow: number
  innerConstellation: number
  innerLight: number
  innerPresence: number
  lanternBreath: number
  lanternWarmth: number
  luminousCore: number
  melodyPhase: number
  musicLightExposure: number
  orbitalDrift: number
  previousBass: number
  resonanceWave: number
  ringPhase: number
  shellFlow: number
  softCoreBreath: number
  trebleAfterglow: number
  visualBeatRelease: number
  warmth: number
}

const stateConfig: Record<ParticleState, VisualConfig> = {
  idle: createConfig(['#f0c879', '#72d6ec', '#d987a4', '#8fe4cb', '#d8c578'], 0.82, 0.022, 1.02, 0.36, 0.014),
  listening: createConfig(['#e7fff7', '#97ffe4', '#00e0a4', '#6ee7ff'], 0.84, 0.025, 1.1, 0.76, 0.026),
  thinking: createConfig(['#ffc266', '#ff8f64', '#ff6f91', '#b88cff'], 0.76, 0.018, 0.94, 0.96, 0.009),
  speaking: createConfig(['#fff7e6', '#f7d987', '#80e4ff', '#b8f6ea'], 0.9, 0.025, 1.08, 0.62, 0.014),
  playing: createConfig(['#ffe16f', '#ff8f64', '#00d5c8', '#84ddff'], 0.86, 0.024, 1.16, 0.54, 0.018),
  error: createConfig(['#ff8f8f', '#c85d6d', '#6b2534'], 0.54, 0.019, 0.98, 0.28, 0.007)
}

const container = ref<HTMLElement | null>(null)
const particleCount = 2400
const MUSIC_LAYER_SHELL = MUSIC_PARTICLE_LAYER_SHELL
const MUSIC_LAYER_CLOUD = MUSIC_PARTICLE_LAYER_CLOUD
const MUSIC_LAYER_CORE = MUSIC_PARTICLE_LAYER_CORE
const basePositions = new Float32Array(particleCount * 3)
const baseRadii = new Float32Array(particleCount)
const directions = new Float32Array(particleCount * 3)
const phases = new Float32Array(particleCount)
const colorMix = new Float32Array(particleCount)
const musicLayers = new Uint8Array(particleCount)
const musicRadii = new Float32Array(particleCount)
const musicRhythmGroups = new Uint8Array(particleCount)
const musicSeeds = new Float32Array(particleCount)
const musicWarmth = new Float32Array(particleCount)
const positions = new Float32Array(particleCount * 3)
const colors = new Float32Array(particleCount * 3)

let animationFrame = 0
let camera: THREE.PerspectiveCamera | undefined
let coreGlow: THREE.Sprite | undefined
let coreGlowMaterial: THREE.SpriteMaterial | undefined
let coreGlowTexture: THREE.Texture | undefined
let geometry: THREE.BufferGeometry | undefined
let innerGlow: THREE.Sprite | undefined
let innerGlowMaterial: THREE.SpriteMaterial | undefined
let innerGlowTexture: THREE.Texture | undefined
let material: THREE.PointsMaterial | undefined
let outerGlow: THREE.Sprite | undefined
let outerGlowMaterial: THREE.SpriteMaterial | undefined
let outerGlowTexture: THREE.Texture | undefined
let points: THREE.Points | undefined
let renderer: THREE.WebGLRenderer | undefined
let resizeObserver: ResizeObserver | undefined
let scene: THREE.Scene | undefined
let rotationVelocityX = 0
let rotationVelocityY = 0
let sphereRotationX = 0
let sphereRotationY = 0
let startedAt = 0
let previousFrameAt = 0
let visualConfig = stateConfig.idle
const smoothedMusicBands: MusicAudioBands = {
  bass: 0,
  beat: 0,
  centroid: 0.32,
  flux: 0,
  mid: 0,
  treble: 0
}
const musicMotion: MusicMotionState = {
  afterglowBands: 0,
  beatGate: 0,
  beatImpulse: 0,
  beatTravel: 1,
  bodyBreath: 0,
  glowBloom: 0,
  hazeGlow: 0,
  innerConstellation: 0,
  innerLight: 0,
  innerPresence: 0,
  lanternBreath: 0,
  lanternWarmth: 0,
  luminousCore: 0,
  melodyPhase: 0,
  musicLightExposure: 0,
  orbitalDrift: 0,
  previousBass: 0,
  resonanceWave: 0,
  ringPhase: 0,
  shellFlow: 0,
  softCoreBreath: 0,
  trebleAfterglow: 0,
  visualBeatRelease: 0,
  warmth: 0
}
const musicBaseColor = new THREE.Color()
const musicAccentColor = new THREE.Color()
const musicGold = new THREE.Color('#ffe16f')
const musicMilk = new THREE.Color('#fff6da')
const musicTeal = new THREE.Color('#2ee6d6')
const MUSIC_CORE_MILK_MIX = 0.34
const MUSIC_SOFT_LIGHT_CEILING = 1.86
let musicAuraEngine = createMusicAuraEngineState()
let musicMelodyFlow = createMusicMelodyFlowState()

function createConfig(
  palette: string[],
  opacity: number,
  pointSize: number,
  radius: number,
  speed: number,
  tightness: number
): VisualConfig {
  return {
    palette: palette.map((color) => new THREE.Color(color)),
    opacity,
    pointSize,
    radius,
    speed,
    tightness
  }
}

function createParticleTexture(): THREE.Texture {
  const size = 96
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')

  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2
    )
    gradient.addColorStop(0, 'rgba(255,255,255,1)')
    gradient.addColorStop(0.22, 'rgba(255,255,255,0.72)')
    gradient.addColorStop(0.56, 'rgba(255,255,255,0.18)')
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, size, size)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  return texture
}

function createGlowTexture(): THREE.Texture {
  const size = 160
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')

  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2
    )
    gradient.addColorStop(0, 'rgba(255,255,255,0.44)')
    gradient.addColorStop(0.28, 'rgba(255,246,218,0.24)')
    gradient.addColorStop(0.6, 'rgba(46,230,214,0.08)')
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, size, size)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  return texture
}

function createDiffuseGlowTexture(): THREE.Texture {
  const size = 224
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')

  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2
    )
    gradient.addColorStop(0, 'rgba(255,246,218,0.28)')
    gradient.addColorStop(0.34, 'rgba(255,225,111,0.14)')
    gradient.addColorStop(0.68, 'rgba(46,230,214,0.07)')
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, size, size)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.needsUpdate = true
  return texture
}

function seedParticles(): void {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))

  for (let index = 0; index < particleCount; index += 1) {
    const y = 1 - (index / (particleCount - 1)) * 2
    const radius = Math.sqrt(1 - y * y)
    const theta = goldenAngle * index
    const x = Math.cos(theta) * radius
    const z = Math.sin(theta) * radius
    const offset = index * 3
    const shell = 0.82 + Math.random() * 0.18
    const layerRoll = Math.random()
    const layer = layerRoll > 0.93
      ? MUSIC_LAYER_CORE
      : layerRoll > 0.7
        ? MUSIC_LAYER_CLOUD
        : MUSIC_LAYER_SHELL
    const innerRadius = layer === MUSIC_LAYER_CORE
      ? 0.16 + Math.cbrt(Math.random()) * 0.25
      : layer === MUSIC_LAYER_CLOUD
        ? 0.36 + Math.random() * 0.42
        : shell

    directions[offset] = x
    directions[offset + 1] = y
    directions[offset + 2] = z
    baseRadii[index] = shell
    basePositions[offset] = x * shell
    basePositions[offset + 1] = y * shell
    basePositions[offset + 2] = z * shell
    phases[index] = Math.random() * Math.PI * 2
    colorMix[index] = Math.random()
    musicLayers[index] = layer
    musicRadii[index] = innerRadius
    musicRhythmGroups[index] = Math.floor(Math.random() * 24)
    musicSeeds[index] = Math.random()
    musicWarmth[index] = Math.random()
  }
}

function updateColors(config: VisualConfig): void {
  const color = new THREE.Color()
  const segmentCount = Math.max(1, config.palette.length - 1)

  for (let index = 0; index < particleCount; index += 1) {
    const scaledMix = colorMix[index] * segmentCount
    const paletteIndex = Math.min(Math.floor(scaledMix), config.palette.length - 2)
    const localMix = scaledMix - paletteIndex
    color.copy(config.palette[paletteIndex]).lerp(config.palette[paletteIndex + 1], localMix)

    if (props.state === 'idle') {
      color.offsetHSL(0, 0.05, -0.05 + Math.sin(phases[index]) * 0.035)
    }

    const offset = index * 3
    colors[offset] = color.r
    colors[offset + 1] = color.g
    colors[offset + 2] = color.b
  }

  const colorAttribute = geometry?.attributes.color
  if (colorAttribute) {
    colorAttribute.needsUpdate = true
  }
}

function resize(): void {
  if (!container.value || !camera || !renderer) {
    return
  }

  const { clientHeight, clientWidth } = container.value
  renderer.setSize(clientWidth, clientHeight, false)
  camera.aspect = clientWidth / Math.max(1, clientHeight)
  camera.updateProjectionMatrix()
}

function clamp01(value: number): number {
  return THREE.MathUtils.clamp(value, 0, 1)
}

function followBand(current: number, target: number, attack: number, release: number): number {
  return THREE.MathUtils.lerp(current, target, target > current ? attack : release)
}

function releaseVisualBeat(current: number, rawBeat: number): number {
  return THREE.MathUtils.lerp(current, rawBeat, rawBeat > current ? 0.22 : 0.045)
}

function updateSmoothedMusicBands(isPlaying: boolean): MusicAudioBands {
  const rawBeat = clamp01(props.audioBands.beat ?? Math.max(props.audioBands.flux ?? 0, props.audioBands.bass - 0.38))
  const targets: MusicAudioBands = {
    bass: isPlaying ? clamp01(props.audioBands.bass) : 0,
    beat: isPlaying ? rawBeat : 0,
    centroid: isPlaying ? clamp01(props.audioBands.centroid ?? 0.32) : 0.32,
    flux: isPlaying ? clamp01(props.audioBands.flux ?? 0) : 0,
    mid: isPlaying ? clamp01(props.audioBands.mid) : 0,
    treble: isPlaying ? clamp01(props.audioBands.treble) : 0
  }

  smoothedMusicBands.bass = followBand(smoothedMusicBands.bass, targets.bass, 0.08, 0.035)
  smoothedMusicBands.centroid = THREE.MathUtils.lerp(smoothedMusicBands.centroid ?? 0.32, targets.centroid ?? 0.32, 0.04)
  smoothedMusicBands.flux = THREE.MathUtils.lerp(
    smoothedMusicBands.flux ?? 0,
    targets.flux ?? 0,
    (targets.flux ?? 0) > (smoothedMusicBands.flux ?? 0) ? 0.18 : 0.08
  )
  smoothedMusicBands.mid = followBand(smoothedMusicBands.mid, targets.mid, 0.052, 0.026)
  smoothedMusicBands.treble = followBand(smoothedMusicBands.treble, targets.treble, 0.14, 0.16)
  smoothedMusicBands.beat = releaseVisualBeat(smoothedMusicBands.beat ?? 0, targets.beat ?? 0)

  return smoothedMusicBands
}

function updateMusicMotion(
  bands: MusicAudioBands,
  deltaSeconds: number,
  isPlaying: boolean
): MusicMotionState {
  musicAuraEngine = advanceMusicAuraEngine(musicAuraEngine, bands, deltaSeconds, isPlaying)
  musicMelodyFlow = advanceMusicMelodyFlow(musicMelodyFlow, bands, deltaSeconds, isPlaying)

  if (!isPlaying) {
    musicMotion.afterglowBands = THREE.MathUtils.lerp(musicMotion.afterglowBands, 0, 0.09)
    musicMotion.beatGate = THREE.MathUtils.lerp(musicMotion.beatGate, 0, 0.1)
    musicMotion.beatImpulse *= 0.86
    musicMotion.beatTravel = THREE.MathUtils.lerp(musicMotion.beatTravel, 1, 0.08)
    musicMotion.bodyBreath = THREE.MathUtils.lerp(musicMotion.bodyBreath, 0, 0.075)
    musicMotion.glowBloom = THREE.MathUtils.lerp(musicMotion.glowBloom, 0, 0.075)
    musicMotion.hazeGlow = THREE.MathUtils.lerp(musicMotion.hazeGlow, 0, 0.08)
    musicMotion.innerConstellation = THREE.MathUtils.lerp(musicMotion.innerConstellation, 0, 0.07)
    musicMotion.innerLight = THREE.MathUtils.lerp(musicMotion.innerLight, 0, 0.06)
    musicMotion.innerPresence = THREE.MathUtils.lerp(musicMotion.innerPresence, 0, 0.08)
    musicMotion.lanternBreath = THREE.MathUtils.lerp(musicMotion.lanternBreath, 0, 0.08)
    musicMotion.lanternWarmth = THREE.MathUtils.lerp(musicMotion.lanternWarmth, 0, 0.06)
    musicMotion.luminousCore = THREE.MathUtils.lerp(musicMotion.luminousCore, 0, 0.08)
    musicMotion.musicLightExposure = THREE.MathUtils.lerp(musicMotion.musicLightExposure, 0, 0.08)
    musicMotion.orbitalDrift = THREE.MathUtils.lerp(musicMotion.orbitalDrift, 0, 0.08)
    musicMotion.resonanceWave = THREE.MathUtils.lerp(musicMotion.resonanceWave, 0, 0.08)
    musicMotion.shellFlow = THREE.MathUtils.lerp(musicMotion.shellFlow, 0, 0.08)
    musicMotion.softCoreBreath = THREE.MathUtils.lerp(musicMotion.softCoreBreath, 0, 0.08)
    musicMotion.trebleAfterglow *= 0.9
    musicMotion.visualBeatRelease = THREE.MathUtils.lerp(musicMotion.visualBeatRelease, 0, 0.08)
    musicMotion.warmth = THREE.MathUtils.lerp(musicMotion.warmth, 0, 0.06)
    musicMotion.previousBass = THREE.MathUtils.lerp(musicMotion.previousBass, 0, 0.08)
    return musicMotion
  }

  const bass = clamp01(bands.bass)
  const beat = clamp01(bands.beat ?? 0)
  const centroid = clamp01(bands.centroid ?? 0.32)
  const flux = clamp01(bands.flux ?? 0)
  const mid = clamp01(bands.mid)
  const treble = clamp01(bands.treble)
  const beatOnset = Math.max(0, bass - musicMotion.previousBass)
  const onsetPulse = THREE.MathUtils.smoothstep(beatOnset + flux * 0.36, 0.035, 0.19)
  const beatDecay = Math.pow(0.045, deltaSeconds)
  const reactorBeat = clamp01(musicAuraEngine.coreFlash)
  const beatGate = Math.max(beat, reactorBeat * 0.92, THREE.MathUtils.smoothstep(bass + flux * 0.42, 0.38, 0.74))

  musicMotion.beatImpulse = Math.max(musicMotion.beatImpulse * beatDecay, onsetPulse * 0.34, reactorBeat * 0.76)
  if (reactorBeat > 0.42) {
    musicMotion.beatTravel = 0
  } else {
    musicMotion.beatTravel = Math.min(1, musicMotion.beatTravel + deltaSeconds * (1.05 + bass * 0.62))
  }
  musicMotion.beatGate = THREE.MathUtils.lerp(
    musicMotion.beatGate,
    Math.max(beatGate, onsetPulse * 0.82),
    0.12
  )
  musicMotion.visualBeatRelease = Math.max(
    musicMotion.visualBeatRelease * Math.pow(0.16, deltaSeconds),
    beatGate * 0.76 + onsetPulse * 0.24 + reactorBeat * 0.38
  )
  musicMotion.innerPresence = THREE.MathUtils.lerp(musicMotion.innerPresence, 1, 0.045)
  musicMotion.melodyPhase += deltaSeconds * (0.2 + mid * 0.34 + bass * 0.06 + centroid * 0.14)
  musicMotion.orbitalDrift = THREE.MathUtils.lerp(
    musicMotion.orbitalDrift,
    0.3 + mid * 0.42 + centroid * 0.16,
    0.035
  )
  musicMotion.ringPhase += deltaSeconds * (0.06 + musicMotion.orbitalDrift * 0.045)
  musicMotion.resonanceWave = THREE.MathUtils.lerp(
    musicMotion.resonanceWave,
    0.16 + musicMotion.visualBeatRelease * 0.58 + bass * 0.14,
    0.09
  )
  musicMotion.afterglowBands = Math.max(
    musicMotion.afterglowBands * Math.pow(0.12, deltaSeconds),
    musicMotion.visualBeatRelease * 0.5 + mid * 0.28
  )
  musicMotion.luminousCore = THREE.MathUtils.lerp(
    musicMotion.luminousCore,
    0.32 + musicAuraEngine.coreEnergy * 0.74 + reactorBeat * 0.5 + mid * 0.18,
    0.085
  )
  musicMotion.softCoreBreath = THREE.MathUtils.lerp(
    musicMotion.softCoreBreath,
    0.18 + musicMotion.visualBeatRelease * 0.34 + bass * 0.16 + mid * 0.14,
    0.075
  )
  musicMotion.hazeGlow = THREE.MathUtils.lerp(
    musicMotion.hazeGlow,
    0.18 + musicMotion.afterglowBands * 0.34 + mid * 0.22,
    0.05
  )
  musicMotion.lanternBreath = THREE.MathUtils.lerp(
    musicMotion.lanternBreath,
    0.16 + bass * 0.2 + mid * 0.18 + musicMotion.visualBeatRelease * 0.36,
    0.055
  )
  musicMotion.lanternWarmth = THREE.MathUtils.lerp(
    musicMotion.lanternWarmth,
    0.18 + bass * 0.3 + mid * 0.22 + treble * 0.06,
    0.045
  )
  musicMotion.innerConstellation = THREE.MathUtils.lerp(
    musicMotion.innerConstellation,
    0.22 + mid * 0.48 + treble * 0.2 + musicMotion.beatImpulse * 0.48 + reactorBeat * 0.46,
    0.065
  )
  musicMotion.musicLightExposure = THREE.MathUtils.lerp(
    musicMotion.musicLightExposure,
    0.36 + bass * 0.24 + mid * 0.24 + musicMotion.afterglowBands * 0.26,
    0.05
  )
  musicMotion.innerLight = THREE.MathUtils.lerp(
    musicMotion.innerLight,
    0.18 + mid * 0.64 + bass * 0.3 + musicMotion.beatImpulse * 0.34 + musicAuraEngine.coreEnergy * 0.34,
    0.045
  )
  musicMotion.glowBloom = THREE.MathUtils.lerp(
    musicMotion.glowBloom,
    0.18 + bass * 0.42 + mid * 0.18 + musicMotion.beatImpulse * 0.28,
    0.055
  )
  musicMotion.trebleAfterglow = Math.max(
    musicMotion.trebleAfterglow * Math.pow(0.018, deltaSeconds),
    treble * 0.12 + flux * 0.04
  )
  musicMotion.bodyBreath = THREE.MathUtils.lerp(
    musicMotion.bodyBreath,
    bass * 0.018 + musicMotion.beatImpulse * 0.012,
    0.05
  )
  musicMotion.shellFlow = THREE.MathUtils.lerp(
    musicMotion.shellFlow,
    mid * 0.0048 + centroid * 0.0016,
    0.04
  )
  musicMotion.warmth = THREE.MathUtils.lerp(
    musicMotion.warmth,
    0.12 + bass * 0.28 + mid * 0.18,
    0.035
  )
  musicMotion.previousBass = bass

  return musicMotion
}

function updateMusicGlow(bands: MusicAudioBands, motion: MusicMotionState, isPlaying: boolean): void {
  if (!coreGlow || !coreGlowMaterial || !innerGlow || !innerGlowMaterial || !outerGlow || !outerGlowMaterial) {
    return
  }

  if (!isPlaying) {
    coreGlowMaterial.opacity = THREE.MathUtils.lerp(coreGlowMaterial.opacity, 0, 0.08)
    innerGlowMaterial.opacity = THREE.MathUtils.lerp(innerGlowMaterial.opacity, 0, 0.1)
    outerGlowMaterial.opacity = THREE.MathUtils.lerp(outerGlowMaterial.opacity, 0, 0.08)
    return
  }

  const mid = clamp01(bands.mid)
  const treble = clamp01(bands.treble)
  const reactor = calculateCoreReactor(musicAuraEngine, bands)
  const coreOpacity = reactor.opacity
  const innerOpacity = clamp01(0.08 + motion.innerConstellation * 0.22 + motion.visualBeatRelease * 0.14 + musicAuraEngine.coreFlash * 0.12)
  const hazeOpacity = clamp01(0.08 + motion.hazeGlow * 0.22 + motion.afterglowBands * 0.12)
  const warmth = reactor.warmth
  const phase = motion.melodyPhase
  const driftRadius = 0.055 + mid * 0.028 + musicMelodyFlow.motion * 0.035

  coreGlowMaterial.opacity = THREE.MathUtils.lerp(coreGlowMaterial.opacity, coreOpacity, 0.16)
  coreGlowMaterial.color.copy(musicTeal).lerp(musicGold, warmth * 0.72).lerp(musicMilk, 0.18 + musicAuraEngine.coreFlash * 0.22)
  coreGlow.scale.setScalar(reactor.scale)
  coreGlow.position.set(0, 0, -0.02)

  innerGlowMaterial.opacity = THREE.MathUtils.lerp(innerGlowMaterial.opacity, innerOpacity, 0.15)
  innerGlowMaterial.color.copy(musicGold).lerp(musicMilk, 0.24 + treble * 0.12 + musicAuraEngine.coreFlash * 0.16)
  innerGlow.scale.setScalar(0.58 + motion.innerConstellation * 0.16 + musicAuraEngine.coreFlash * 0.1)
  innerGlow.position.set(
    Math.cos(musicMelodyFlow.angle) * driftRadius,
    musicMelodyFlow.lift * 0.28 + Math.sin(phase * 0.58 + 0.8) * (0.028 + mid * 0.018),
    Math.sin(musicMelodyFlow.angle) * driftRadius + 0.04 + Math.sin(phase * 0.46) * 0.025
  )

  outerGlowMaterial.opacity = THREE.MathUtils.lerp(outerGlowMaterial.opacity, hazeOpacity, 0.055)
  outerGlowMaterial.color.copy(musicTeal).lerp(musicGold, warmth * 0.48)
  outerGlow.scale.setScalar(1.44 + motion.hazeGlow * 0.28 + motion.afterglowBands * 0.1)
  outerGlow.position.set(0, 0, -0.08)
}

function updateMusicColors(bands: MusicAudioBands, motion: MusicMotionState, elapsed: number): void {
  if (!geometry) {
    return
  }

  const energy = clamp01((bands.bass + bands.mid + bands.treble) / 3)
  const musicLightExposure = 0.78 + motion.musicLightExposure * 0.36 + musicAuraEngine.coreFlash * 0.16
  const lanternBreath = 0.5 + Math.sin(motion.melodyPhase * 1.32) * 0.5
  const lanternWarmth = clamp01(motion.lanternWarmth)
  const innerConstellation = clamp01(motion.innerConstellation)
  const luminousCore = clamp01(motion.luminousCore)
  const lightPhase = motion.melodyPhase * 0.82
  const lightAx = Math.cos(lightPhase)
  const lightAy = Math.sin(lightPhase * 0.72) * 0.34
  const lightAz = Math.sin(lightPhase)
  const lightBx = Math.cos(-lightPhase * 0.76 + 2.1)
  const lightBy = Math.sin(lightPhase * 0.54 + 1.4) * 0.38
  const lightBz = Math.sin(-lightPhase * 0.76 + 2.1)
  const segmentCount = Math.max(1, visualConfig.palette.length - 1)

  for (let index = 0; index < particleCount; index += 1) {
    const offset = index * 3
    const dx = directions[offset]
    const dy = directions[offset + 1]
    const dz = directions[offset + 2]
    const layer = musicLayers[index]
    const phase = phases[index]
    const seed = musicSeeds[index]
    const radius = musicRadii[index]
    const scaledMix = colorMix[index] * segmentCount
    const paletteIndex = Math.min(Math.floor(scaledMix), visualConfig.palette.length - 2)
    const localMix = scaledMix - paletteIndex
    const lightDotA = Math.max(0, dx * lightAx + dy * lightAy + dz * lightAz)
    const lightDotB = Math.max(0, dx * lightBx + dy * lightBy + dz * lightBz)
    const innerBeam =
      (Math.pow(lightDotA, 10) + Math.pow(lightDotB, 12)) *
      (0.46 + motion.innerLight * 1.35)
    const beatFront = 0.18 + motion.beatTravel * 0.78
    const beatDistance = Math.abs(radius - beatFront)
    const coreBeatWave =
      Math.exp(-(beatDistance * beatDistance) / 0.032) *
      motion.resonanceWave *
      (layer === MUSIC_LAYER_CORE ? 1.26 : layer === MUSIC_LAYER_CLOUD ? 0.82 : 0.28)
    const cloudAfterglow =
      Math.exp(-Math.pow(radius - 0.54, 2) / 0.18) *
      motion.afterglowBands *
      (layer === MUSIC_LAYER_SHELL ? 0.16 : 0.76)
    const coreLantern =
      Math.exp(-Math.pow(radius - 0.28, 2) / 0.08) *
      (0.18 + motion.innerLight * 0.34 + innerConstellation * 0.3 + luminousCore * 0.42)
    const innerConstellationFlicker =
      Math.pow((Math.sin(phase * 1.7 + motion.melodyPhase * 3.2) + 1) / 2, 5) *
      innerConstellation *
      (layer === MUSIC_LAYER_SHELL ? 0.12 : 0.72)
    const innerRhythmLight =
      coreLantern * 0.78 +
      coreBeatWave * 0.98 +
      cloudAfterglow * 0.62 +
      innerConstellationFlicker * 0.38
    const lanternPulse =
      coreLantern *
      (0.74 + lanternBreath * 0.18 + motion.beatGate * 0.16) *
      (layer === MUSIC_LAYER_CORE ? 1.02 : layer === MUSIC_LAYER_CLOUD ? 0.74 : 0.28)
    const {
      auraBloom,
      auraInternalLight,
      auraMelodyLight,
      auraMilkMix,
      auraPulseLight,
      auraTealMix,
      auraTrebleLight,
      auraWarmth,
      melodyRibbon,
      trebleSpark
    } = calculateAuraParticleLight({
      bass: bands.bass,
      cloudAfterglow,
      directionX: dx,
      directionY: dy,
      directionZ: dz,
      group: musicRhythmGroups[index],
      innerBeam,
      layer,
      melodyPhase: motion.melodyPhase,
      mid: bands.mid,
      phase,
      pulses: musicAuraEngine.pulses,
      radius,
      seed,
      treble: bands.treble,
      trebleAfterglow: motion.trebleAfterglow,
      visualBeatRelease: motion.visualBeatRelease,
      warmthSeed: musicWarmth[index]
    })
    const {
      melodyMilk,
      melodyTeal,
      ribbonLight,
      ribbonSpark
    } = calculateMelodyRibbonLight({
      directionX: dx,
      directionY: dy,
      directionZ: dz,
      layer,
      phase,
      radius,
      seed,
      state: musicMelodyFlow
    })
    const layeredInternalLight = auraInternalLight
    const layerLight = layer === MUSIC_LAYER_CORE
      ? motion.innerLight * 0.58 + bands.bass * 0.16 + motion.glowBloom * 0.1
      : layer === MUSIC_LAYER_CLOUD
        ? motion.innerLight * 0.42 + bands.mid * 0.14
        : energy * 0.1 + motion.glowBloom * 0.04
    const warmth = clamp01(motion.warmth + lanternWarmth * 0.28 + musicWarmth[index] * 0.08)
    const baseBrightness = layer === MUSIC_LAYER_CORE
      ? 0.14
      : layer === MUSIC_LAYER_CLOUD
        ? 0.13
        : 0.1
    const shellTint = layer === MUSIC_LAYER_SHELL ? motion.hazeGlow * 0.22 + energy * 0.08 : 0
    const perceptualBrightness = Math.min(MUSIC_SOFT_LIGHT_CEILING,
      baseBrightness +
      layerLight +
      innerBeam * (layer === MUSIC_LAYER_SHELL ? 0.4 : 0.92) +
      melodyRibbon * 0.26 +
      innerRhythmLight * 0.48 +
      layeredInternalLight * 0.32 +
      ribbonLight * 2.45 +
      ribbonSpark * 2.9 +
      auraPulseLight * 2.15 +
      auraMelodyLight * 0.16 +
      auraTrebleLight * 0.2 +
      auraBloom * 2.05 +
      lanternPulse * 0.28 +
      shellTint +
      trebleSpark +
      motion.visualBeatRelease * (layer === MUSIC_LAYER_CORE ? 0.22 : 0.05)
    )

    musicBaseColor
      .copy(visualConfig.palette[paletteIndex])
      .lerp(visualConfig.palette[paletteIndex + 1], localMix)
      .lerp(musicGold, clamp01(warmth * 0.36 + auraWarmth * 0.42))
      .lerp(musicTeal, clamp01((1 - warmth) * 0.08 + auraTealMix * 0.22 + melodyTeal * 0.34))
    musicAccentColor.copy(musicBaseColor).lerp(musicMilk, layeredInternalLight * MUSIC_CORE_MILK_MIX + auraMilkMix * 0.4 + melodyMilk * 0.68)
    musicAccentColor.lerp(
      musicMilk,
      clamp01(innerBeam + ribbonLight * 1.8 + ribbonSpark * 2.4 + auraPulseLight * 1.55 + lanternPulse + innerRhythmLight + melodyRibbon * 0.24 + cloudAfterglow * 0.18 + trebleSpark) *
      MUSIC_CORE_MILK_MIX *
      0.72
    )
    musicAccentColor.multiplyScalar(perceptualBrightness * musicLightExposure)

    colors[offset] = musicAccentColor.r
    colors[offset + 1] = musicAccentColor.g
    colors[offset + 2] = musicAccentColor.b
  }

  const colorAttribute = geometry.attributes.color
  if (colorAttribute) {
    colorAttribute.needsUpdate = true
  }
}

function animate(now: number): void {
  animationFrame = requestAnimationFrame(animate)

  if (!geometry || !material || !points || !renderer || !scene || !camera) {
    return
  }

  const elapsed = (now - startedAt) / 1000
  const deltaSeconds = previousFrameAt > 0 ? Math.min(0.05, (now - previousFrameAt) / 1000) : 1 / 60
  previousFrameAt = now
  const level = THREE.MathUtils.clamp(props.audioLevel, 0, 1)
  const isPlaying = props.state === 'playing'
  const bands = updateSmoothedMusicBands(isPlaying)
  const motion = updateMusicMotion(bands, deltaSeconds, isPlaying)
  const bass = bands.bass
  const mid = bands.mid
  const treble = bands.treble
  const breath = Math.sin(elapsed * (0.76 + visualConfig.speed)) * (isPlaying ? 0.008 : 0.026)
  const isSpeaking = props.state === 'speaking'
  const musicalBreath = isPlaying ? motion.bodyBreath : 0
  const trebleGlint = isPlaying ? motion.trebleAfterglow * 0.004 + treble * 0.0012 : 0
  const speakingPulse = isSpeaking ? level * 0.045 : isPlaying ? musicalBreath : level * 0.14
  const speakingLateral = isSpeaking ? level * 0.008 : isPlaying ? 0 : level * 0.026
  const speakingVertical = isSpeaking ? level * 0.012 : isPlaying ? 0 : level * 0.038
  const swirl = isPlaying
    ? motion.ringPhase + Math.sin(motion.melodyPhase * 0.6) * 0.018
    : elapsed * visualConfig.speed

  for (let index = 0; index < particleCount; index += 1) {
    const offset = index * 3
    const dx = directions[offset]
    const dy = directions[offset + 1]
    const dz = directions[offset + 2]
    const phase = phases[index]
    const layer = musicLayers[index]
    const layerRadius = isPlaying && layer !== MUSIC_LAYER_SHELL
      ? THREE.MathUtils.lerp(baseRadii[index], musicRadii[index], motion.innerPresence)
      : baseRadii[index]
    const melodyWave = Math.sin(musicMelodyFlow.angle * 1.7 + dy * 2.6 + phase + musicMelodyFlow.lift * 1.4)
    const melodyLiftMask = Math.exp(-Math.pow(dy - musicMelodyFlow.lift, 2) / 0.22)
    const wave = Math.sin(elapsed * (1.04 + visualConfig.speed * 0.48) + phase)
    const musicLayerFlow = isPlaying
      ? layer === MUSIC_LAYER_CORE
        ? Math.sin(elapsed * 0.82 + phase) * bass * 0.0038 + motion.beatGate * 0.0025
        : layer === MUSIC_LAYER_CLOUD
          ? melodyWave * mid * 0.0055 + melodyLiftMask * musicMelodyFlow.motion * 0.008 + motion.resonanceWave * 0.0012
          : Math.sin(elapsed * 0.22 + phase) * motion.shellFlow * 0.38
      : 0
    const ring = isPlaying
      ? Math.sin(swirl + dy * Math.PI + phase) * (visualConfig.tightness * 0.22 + motion.shellFlow)
      : Math.sin(swirl + dy * Math.PI + phase) * visualConfig.tightness
    const voiceWave = isSpeaking ? Math.sin(elapsed * 2.2 + dy * 4.4 + phase) * level * 0.018 : 0
    const radius =
      visualConfig.radius +
      breath +
      speakingPulse +
      (isPlaying ? musicLayerFlow : wave * visualConfig.tightness) +
      voiceWave
    const turn =
      ring +
      (props.state === 'thinking' ? elapsed * 0.06 * dy : 0) +
      (isSpeaking ? Math.sin(elapsed * 0.9 + phase) * 0.006 + elapsed * 0.018 : 0)
    const cos = Math.cos(turn)
    const sin = Math.sin(turn)
    const baseX = isPlaying ? dx * layerRadius : basePositions[offset]
    const baseY = isPlaying ? dy * layerRadius : basePositions[offset + 1]
    const baseZ = isPlaying ? dz * layerRadius : basePositions[offset + 2]
    const x = baseX * radius
    const z = baseZ * radius

    positions[offset] = x * cos - z * sin + dx * speakingLateral * (wave + melodyWave * 0.32)
    positions[offset + 1] = baseY * radius + dy * speakingVertical
    positions[offset + 2] = x * sin + z * cos + dz * speakingLateral * (wave - melodyWave * 0.24)
  }

  geometry.attributes.position.needsUpdate = true
  if (isPlaying) {
    updateMusicColors(bands, motion, elapsed)
  }
  updateMusicGlow(bands, motion, isPlaying)
  material.opacity = THREE.MathUtils.lerp(material.opacity, visualConfig.opacity, 0.04)
  material.size = THREE.MathUtils.lerp(
    material.size,
    visualConfig.pointSize + level * (isSpeaking ? 0.003 : 0.006) + (isPlaying ? trebleGlint : 0),
    0.08
  )
  if (isPlaying) {
    const targetRotationVelocityY = 0.02 + motion.orbitalDrift * 0.026 + bass * 0.003
    const targetRotationTilt = Math.sin(motion.melodyPhase * 0.32) * (0.01 + mid * 0.01)
    rotationVelocityY = THREE.MathUtils.lerp(rotationVelocityY, targetRotationVelocityY, 0.026)
    rotationVelocityX = THREE.MathUtils.lerp(
      rotationVelocityX,
      (targetRotationTilt - sphereRotationX) * 0.09,
      0.045
    )
    sphereRotationY += deltaSeconds * rotationVelocityY
    sphereRotationX += rotationVelocityX
    sphereRotationX = THREE.MathUtils.lerp(sphereRotationX, targetRotationTilt, 0.012)
    points.rotation.y = sphereRotationY
    points.rotation.x = sphereRotationX
  } else {
    rotationVelocityX = THREE.MathUtils.lerp(rotationVelocityX, 0, 0.12)
    rotationVelocityY = THREE.MathUtils.lerp(rotationVelocityY, 0, 0.12)
    points.rotation.y = elapsed * (0.08 + visualConfig.speed * (isSpeaking ? 0.16 : 0.08))
    points.rotation.x = Math.sin(elapsed * (isSpeaking ? 0.16 : 0.18)) * (isSpeaking ? 0.045 : 0.08)
    sphereRotationY = points.rotation.y
    sphereRotationX = points.rotation.x
  }
  renderer.render(scene, camera)
}

function setupScene(): void {
  if (!container.value) {
    return
  }

  seedParticles()
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100)
  camera.position.z = 4.6

  geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

  material = new THREE.PointsMaterial({
    alphaMap: createParticleTexture(),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: visualConfig.opacity,
    size: visualConfig.pointSize,
    transparent: true,
    vertexColors: true
  })

  points = new THREE.Points(geometry, material)
  scene.add(points)
  updateColors(visualConfig)

  coreGlowTexture = createGlowTexture()
  coreGlowMaterial = new THREE.SpriteMaterial({
    blending: THREE.AdditiveBlending,
    color: musicTeal,
    depthTest: false,
    depthWrite: false,
    map: coreGlowTexture,
    opacity: 0,
    transparent: true
  })
  coreGlow = new THREE.Sprite(coreGlowMaterial)
  coreGlow.renderOrder = 1
  scene.add(coreGlow)

  innerGlowTexture = createGlowTexture()
  innerGlowMaterial = new THREE.SpriteMaterial({
    blending: THREE.AdditiveBlending,
    color: musicGold,
    depthTest: false,
    depthWrite: false,
    map: innerGlowTexture,
    opacity: 0,
    transparent: true
  })
  innerGlow = new THREE.Sprite(innerGlowMaterial)
  innerGlow.renderOrder = 2
  scene.add(innerGlow)

  outerGlowTexture = createDiffuseGlowTexture()
  outerGlowMaterial = new THREE.SpriteMaterial({
    blending: THREE.AdditiveBlending,
    color: musicTeal,
    depthTest: false,
    depthWrite: false,
    map: outerGlowTexture,
    opacity: 0,
    transparent: true
  })
  outerGlow = new THREE.Sprite(outerGlowMaterial)
  outerGlow.renderOrder = 0
  scene.add(outerGlow)

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setClearAlpha(0)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  container.value.appendChild(renderer.domElement)

  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container.value)
  resize()

  startedAt = performance.now()
  previousFrameAt = startedAt
  sphereRotationX = 0
  sphereRotationY = 0
  rotationVelocityX = 0
  rotationVelocityY = 0
  animationFrame = requestAnimationFrame(animate)
}

watch(
  () => props.state,
  (state) => {
    visualConfig = stateConfig[state]
    updateColors(visualConfig)
  }
)

onMounted(setupScene)

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  coreGlowMaterial?.dispose()
  coreGlowTexture?.dispose()
  geometry?.dispose()
  innerGlowMaterial?.dispose()
  innerGlowTexture?.dispose()
  material?.map?.dispose()
  material?.alphaMap?.dispose()
  material?.dispose()
  outerGlowMaterial?.dispose()
  outerGlowTexture?.dispose()
  renderer?.dispose()
  renderer?.domElement.remove()
})
</script>

<template>
  <div ref="container" class="particle-sphere" aria-hidden="true" />
</template>
