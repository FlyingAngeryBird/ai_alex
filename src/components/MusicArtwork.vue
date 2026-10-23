<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Music2 } from 'lucide-vue-next'
import type { MusicTrack } from '../types/app'
const props = defineProps<{ track: MusicTrack }>()
const emit = defineEmits<{ needed: [track: MusicTrack] }>()
const root = ref<HTMLElement | null>(null), failed = ref(false)
let observer: IntersectionObserver | null = null, visible = false, requested = ''
function request(): void {
  const key = `${props.track.source}:${props.track.id}`
  if (visible && !props.track.artworkUrl && requested !== key) { requested = key; emit('needed', props.track) }
}
watch(() => [props.track.source, props.track.id, props.track.artworkUrl], (_value, previous) => { failed.value = false; if (previous?.[2] && !props.track.artworkUrl) requested = ''; request() })
onMounted(() => {
  observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); request() }, { rootMargin: '60px' })
  if (root.value) observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>
<template>
  <span ref="root" class="music-artwork" aria-hidden="true">
    <img v-if="track.artworkUrl && !failed" :key="track.artworkUrl" :src="track.artworkUrl" alt="" loading="lazy" @error="failed = true" />
    <Music2 v-else :size="19" />
  </span>
</template>
<style scoped>
.music-artwork{display:grid;place-items:center;width:42px;height:42px;overflow:hidden;border-radius:6px;background:#a1d9cf0b;color:#a1d9cf9c;flex:none}.music-artwork img{width:100%;height:100%;object-fit:cover;display:block}
</style>
