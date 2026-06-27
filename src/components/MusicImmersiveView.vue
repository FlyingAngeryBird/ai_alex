<script setup lang="ts">
import { computed } from 'vue'
import type { PlaybackState } from '@/types/app'

const props = defineProps<{
  playback: PlaybackState
}>()

defineEmits<{
  back: []
  togglePlayback: []
}>()

const progress = computed(() => {
  if (!props.playback.durationMs) {
    return 0
  }

  return Math.min(100, (props.playback.positionMs / props.playback.durationMs) * 100)
})

function formatTime(ms: number | null): string {
  if (!ms) {
    return '0:00'
  }

  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}
</script>

<template>
  <section class="music-view" aria-label="音乐沉浸页">
    <header class="music-topbar">
      <button class="round-button" type="button" aria-label="返回聊天" @click="$emit('back')">
        ←
      </button>
      <span>{{ playback.status === 'playing' ? 'Playing' : 'Paused' }}</span>
    </header>

    <div v-if="playback.track" class="music-layout">
      <div class="cover-art" aria-hidden="true">
        <span>{{ playback.track.title.slice(0, 1) }}</span>
      </div>

      <div class="music-copy">
        <p class="eyebrow">{{ playback.track.album }}</p>
        <h2>{{ playback.track.title }}</h2>
        <p class="artist">{{ playback.track.artist }}</p>
        <p v-if="playback.track.recommendation" class="recommendation">
          {{ playback.track.recommendation }}
        </p>

        <div class="progress-block">
          <div class="progress-track" aria-hidden="true">
            <span :style="{ width: `${progress}%` }" />
          </div>
          <div class="time-row">
            <span>{{ formatTime(playback.positionMs) }}</span>
            <span>{{ formatTime(playback.durationMs) }}</span>
          </div>
        </div>

        <button class="primary-play-button" type="button" @click="$emit('togglePlayback')">
          {{ playback.status === 'playing' ? '暂停' : '继续' }}
        </button>
      </div>

      <div class="lyric-stack">
        <p
          v-for="(line, index) in playback.track.lyrics?.length ? playback.track.lyrics : ['暂无歌词', '让音乐先铺开。']"
          :key="`${line}-${index}`"
          :class="{ 'lyric-line--current': index === 1 }"
          class="lyric-line"
        >
          {{ line }}
        </p>
      </div>
    </div>
  </section>
</template>
