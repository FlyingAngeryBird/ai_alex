<script setup lang="ts">
import { vModalFocus } from '@/utils/modalFocus'
import { ref } from 'vue'
const props = defineProps<{ active: boolean; busy: boolean; error: string; track: { key: string; title: string } | null }>()
const emit = defineEmits<{ close: []; start: [durationSec: number, endTargetTrackKey: string | null] }>()
const minutes = ref(25)
const pauseMusic = ref(false)
function start(): void {
  if (props.busy || props.active || !Number.isInteger(minutes.value) || minutes.value < 1 || minutes.value > 180) return
  emit('start', minutes.value * 60, pauseMusic.value ? props.track?.key ?? null : null)
}
</script>
<template>
  <div class="r1-memory-modal-backdrop" role="presentation">
    <form v-modal-focus @keydown.esc.prevent="!busy && emit('close')" class="r1-memory-modal r1-focus-modal" role="dialog" aria-modal="true" aria-label="开始专注"
      @submit.prevent="start">
      <h3>留一点时间给眼前的事</h3><label for="focus-duration">专注分钟数</label>
      <input id="focus-duration" :disabled="busy" v-model.number="minutes" type="number" min="1" max="180" step="1" required />
      <label v-if="track" class="r1-focus-music-rule"><input v-model="pauseMusic" :disabled="busy" type="checkbox" />到时暂停这首歌：{{ track.title }}</label>
      <p>计时保存在这台设备上。睡眠或重启后暂停；默认结束时音乐继续播放。</p>
      <div class="r1-memory-dialog-actions"><button type="button" :disabled="busy" @click="emit('close')">取消</button>
        <button type="submit" :disabled="busy || active">开始专注</button></div>
      <p v-if="active">已有一段专注，请先继续或结束它。</p><p v-if="error" role="alert">{{ error }}</p>
    </form>
  </div>
</template>
