<script setup lang="ts">
import { ref } from 'vue'
defineProps<{ active: boolean; busy: boolean; error: string; track: { key: string; title: string } | null }>()
const emit = defineEmits<{ close: []; start: [durationSec: number, endTargetTrackKey: string | null] }>()
const minutes = ref(25)
const pauseMusic = ref(false)
</script>
<template>
  <div class="r1-memory-modal-backdrop" role="presentation" @click.self="emit('close')">
    <form class="r1-memory-modal r1-focus-modal" role="dialog" aria-modal="true" aria-label="开始专注"
      @submit.prevent="emit('start', minutes * 60, pauseMusic ? track?.key ?? null : null)">
      <h3>留一点时间给眼前的事</h3><label for="focus-duration">专注分钟数</label>
      <input id="focus-duration" v-model.number="minutes" type="number" min="1" max="180" step="1" required />
      <label v-if="track" class="r1-focus-music-rule"><input v-model="pauseMusic" type="checkbox" />到时暂停这首歌：{{ track.title }}</label>
      <p>计时保存在这台设备上。睡眠或重启后暂停；默认结束时音乐继续播放。</p>
      <div class="r1-memory-dialog-actions"><button type="button" @click="emit('close')">取消</button>
        <button type="submit" :disabled="busy || active">开始专注</button></div>
      <p v-if="active">已有一段专注，请先继续或结束它。</p><p v-if="error" role="alert">{{ error }}</p>
    </form>
  </div>
</template>
