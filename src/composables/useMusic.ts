import { computed, getCurrentInstance, onBeforeUnmount, ref } from 'vue'
import type { MusicTrack, PlaybackState, ViewMode } from '@/types/app'

const demoTrack: MusicTrack = {
  id: 'demo-midnight-roam',
  title: '午夜漫游',
  artist: 'Lingli Session',
  album: 'Prototype Tapes',
  durationMs: 184000,
  lyrics: [
    '城市在玻璃里慢慢降噪',
    '一束细小的光贴近心跳',
    '让今晚先流动起来',
    '你只需要跟着呼吸'
  ],
  recommendation: '给一段低速、温暖、带一点电子质感的夜间陪伴。'
}

function createInitialPlayback(): PlaybackState {
  return {
    status: 'idle',
    track: null,
    positionMs: 0,
    durationMs: null
  }
}

export function useMusic() {
  const viewMode = ref<ViewMode>('conversation')
  const playback = ref<PlaybackState>(createInitialPlayback())
  let progressTimer: ReturnType<typeof globalThis.setInterval> | undefined

  const hasActiveTrack = computed(() => playback.value.track !== null)
  const isPlaying = computed(() => playback.value.status === 'playing')

  function clearProgressTimer(): void {
    if (progressTimer !== undefined) {
      globalThis.clearInterval(progressTimer)
      progressTimer = undefined
    }
  }

  function startProgressTimer(): void {
    clearProgressTimer()
    progressTimer = globalThis.setInterval(() => {
      const current = playback.value
      if (current.status !== 'playing' || current.durationMs === null) {
        return
      }

      const nextPosition = Math.min(current.positionMs + 1000, current.durationMs)
      playback.value = {
        ...current,
        positionMs: nextPosition,
        status: nextPosition >= current.durationMs ? 'paused' : current.status
      }
    }, 1000)
  }

  function startDemoTrack(): void {
    playback.value = {
      status: 'playing',
      track: demoTrack,
      positionMs: 18000,
      durationMs: demoTrack.durationMs
    }
    viewMode.value = 'music'
    startProgressTimer()
  }

  function togglePlayback(): void {
    const current = playback.value
    if (!current.track) {
      startDemoTrack()
      return
    }

    if (current.status === 'playing') {
      playback.value = {
        ...current,
        status: 'paused'
      }
      clearProgressTimer()
      return
    }

    playback.value = {
      ...current,
      status: 'playing'
    }
    startProgressTimer()
  }

  function openImmersive(): void {
    if (playback.value.track) {
      viewMode.value = 'music'
    }
  }

  function closeImmersive(): void {
    viewMode.value = 'conversation'
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(clearProgressTimer)
  }

  return {
    closeImmersive,
    hasActiveTrack,
    isPlaying,
    openImmersive,
    playback,
    startDemoTrack,
    togglePlayback,
    viewMode
  }
}
