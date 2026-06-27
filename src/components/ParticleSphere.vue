<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import type { ParticleState } from '@/types/app'

const props = defineProps<{
  audioLevel: number
  state: ParticleState
}>()

type VisualConfig = {
  colorA: THREE.Color
  colorB: THREE.Color
  opacity: number
  pointSize: number
  radius: number
  speed: number
  tightness: number
}

const stateConfig: Record<ParticleState, VisualConfig> = {
  idle: createConfig('#fff2d1', '#70d8ff', 0.64, 0.021, 1.42, 0.42, 0.018),
  listening: createConfig('#e7fff7', '#00e0a4', 0.82, 0.026, 1.5, 0.78, 0.036),
  thinking: createConfig('#ffc266', '#ff6f91', 0.76, 0.019, 1.18, 0.98, 0.012),
  speaking: createConfig('#fff7e6', '#4fd5ff', 0.88, 0.027, 1.48, 0.82, 0.044),
  playing: createConfig('#ffe16f', '#00d5c8', 0.9, 0.028, 1.58, 1.05, 0.052),
  error: createConfig('#ff8f8f', '#6b2534', 0.54, 0.02, 1.24, 0.28, 0.008)
}

const container = ref<HTMLElement | null>(null)
const particleCount = 2400
const basePositions = new Float32Array(particleCount * 3)
const directions = new Float32Array(particleCount * 3)
const phases = new Float32Array(particleCount)
const colorMix = new Float32Array(particleCount)
const positions = new Float32Array(particleCount * 3)
const colors = new Float32Array(particleCount * 3)

let animationFrame = 0
let camera: THREE.PerspectiveCamera | undefined
let geometry: THREE.BufferGeometry | undefined
let material: THREE.PointsMaterial | undefined
let points: THREE.Points | undefined
let renderer: THREE.WebGLRenderer | undefined
let resizeObserver: ResizeObserver | undefined
let scene: THREE.Scene | undefined
let startedAt = 0
let visualConfig = stateConfig.idle

function createConfig(
  colorA: string,
  colorB: string,
  opacity: number,
  pointSize: number,
  radius: number,
  speed: number,
  tightness: number
): VisualConfig {
  return {
    colorA: new THREE.Color(colorA),
    colorB: new THREE.Color(colorB),
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

function seedParticles(): void {
  const goldenAngle = Math.PI * (3 - Math.sqrt(5))

  for (let index = 0; index < particleCount; index += 1) {
    const y = 1 - (index / (particleCount - 1)) * 2
    const radius = Math.sqrt(1 - y * y)
    const theta = goldenAngle * index
    const x = Math.cos(theta) * radius
    const z = Math.sin(theta) * radius
    const offset = index * 3
    const shell = 0.86 + Math.random() * 0.22

    directions[offset] = x
    directions[offset + 1] = y
    directions[offset + 2] = z
    basePositions[offset] = x * shell
    basePositions[offset + 1] = y * shell
    basePositions[offset + 2] = z * shell
    phases[index] = Math.random() * Math.PI * 2
    colorMix[index] = Math.random()
  }
}

function updateColors(config: VisualConfig): void {
  const color = new THREE.Color()

  for (let index = 0; index < particleCount; index += 1) {
    color.copy(config.colorA).lerp(config.colorB, colorMix[index])
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

function animate(now: number): void {
  animationFrame = requestAnimationFrame(animate)

  if (!geometry || !material || !points || !renderer || !scene || !camera) {
    return
  }

  const elapsed = (now - startedAt) / 1000
  const level = THREE.MathUtils.clamp(props.audioLevel, 0, 1)
  const breath = Math.sin(elapsed * (0.76 + visualConfig.speed)) * 0.035
  const pulse = level * 0.18
  const swirl = elapsed * visualConfig.speed

  for (let index = 0; index < particleCount; index += 1) {
    const offset = index * 3
    const dx = directions[offset]
    const dy = directions[offset + 1]
    const dz = directions[offset + 2]
    const phase = phases[index]
    const wave = Math.sin(elapsed * (1.4 + visualConfig.speed) + phase)
    const ring = Math.sin(swirl + dy * Math.PI + phase) * visualConfig.tightness
    const radius = visualConfig.radius + breath + pulse + wave * visualConfig.tightness
    const turn = ring + (props.state === 'thinking' ? elapsed * 0.06 * dy : 0)
    const cos = Math.cos(turn)
    const sin = Math.sin(turn)
    const x = basePositions[offset] * radius
    const z = basePositions[offset + 2] * radius

    positions[offset] = x * cos - z * sin + dx * level * 0.035 * wave
    positions[offset + 1] = basePositions[offset + 1] * radius + dy * level * 0.05
    positions[offset + 2] = x * sin + z * cos + dz * level * 0.035 * wave
  }

  geometry.attributes.position.needsUpdate = true
  material.opacity = THREE.MathUtils.lerp(material.opacity, visualConfig.opacity, 0.04)
  material.size = THREE.MathUtils.lerp(material.size, visualConfig.pointSize + level * 0.006, 0.08)
  points.rotation.y = elapsed * (0.08 + visualConfig.speed * 0.08)
  points.rotation.x = Math.sin(elapsed * 0.22) * 0.08
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

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
  renderer.setClearAlpha(0)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  container.value.appendChild(renderer.domElement)

  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(container.value)
  resize()

  startedAt = performance.now()
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
  geometry?.dispose()
  material?.map?.dispose()
  material?.alphaMap?.dispose()
  material?.dispose()
  renderer?.dispose()
  renderer?.domElement.remove()
})
</script>

<template>
  <div ref="container" class="particle-sphere" aria-hidden="true" />
</template>
