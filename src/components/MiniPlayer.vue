<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { PlaybackState } from '@/types/app'

const props = defineProps<{
  playback: PlaybackState
}>()

defineEmits<{
  open: []
  togglePlayback: []
}>()

const failedArtworkUrl = ref<string | null>(null)
const artworkUrl = computed(() => props.playback.track?.artworkUrl)
watch(() => [props.playback.track?.source, props.playback.track?.id, artworkUrl.value], () => { failedArtworkUrl.value = null })
function artworkFailed(event: Event): void {
  failedArtworkUrl.value = (event.currentTarget as HTMLImageElement).getAttribute('src')
}

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
      <img v-if="artworkUrl && artworkUrl !== failedArtworkUrl" :key="`${playback.track.source}:${playback.track.id}:${artworkUrl}`"
        class="mini-cover mini-cover--image" :src="artworkUrl" alt="" aria-hidden="true" @error="artworkFailed" />
      <span v-else class="mini-cover" aria-hidden="true" />
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

<style scoped>
.mini-cover--image{display:block;object-fit:cover}
</style>
