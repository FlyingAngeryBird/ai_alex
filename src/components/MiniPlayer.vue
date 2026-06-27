<script setup lang="ts">
import { computed } from 'vue'
import type { PlaybackState } from '@/types/app'

const props = defineProps<{
  playback: PlaybackState
}>()

defineEmits<{
  open: []
  togglePlayback: []
}>()

const progress = computed(() => {
  if (!props.playback.durationMs) {
    return 0
  }

  return Math.min(100, (props.playback.positionMs / props.playback.durationMs) * 100)
})
</script>

<template>
  <aside v-if="playback.track" class="mini-player" aria-label="音乐播放器">
    <button class="mini-track" type="button" @click="$emit('open')">
      <span class="mini-cover" />
      <span class="mini-copy">
        <strong>{{ playback.track.title }}</strong>
        <small>{{ playback.track.artist }}</small>
      </span>
    </button>
    <div class="mini-progress" aria-hidden="true">
      <span :style="{ width: `${progress}%` }" />
    </div>
    <button class="round-button" type="button" @click="$emit('togglePlayback')">
      {{ playback.status === 'playing' ? 'Ⅱ' : '▶' }}
    </button>
  </aside>
</template>
