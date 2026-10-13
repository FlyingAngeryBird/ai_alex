<script setup lang="ts">
import { Pause, Play, Timer, X } from 'lucide-vue-next'
import type { FocusState } from '../../electron/main/r1/focus'
defineProps<{ focus: FocusState; busy: boolean }>()
const emit = defineEmits<{ pause: []; resume: []; stop: [] }>()
function formatTime(seconds: number): string {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
</script>
<template>
  <div class="r1-focus-chip" aria-label="当前专注">
    <Timer :size="16" /><span>{{ formatTime(focus.remainingSec) }}</span><small>{{ focus.state === 'paused' ? '已暂停' : '专注中' }}</small>
    <button type="button" :aria-label="focus.state === 'paused' ? '继续专注' : '暂停专注'" :disabled="busy"
      @click="focus.state === 'paused' ? emit('resume') : emit('pause')"><Play v-if="focus.state === 'paused'" :size="14" /><Pause v-else :size="14" /></button>
    <button type="button" aria-label="结束专注" :disabled="busy" @click="emit('stop')"><X :size="14" /></button>
  </div>
</template>
<style scoped>
.r1-focus-chip{position:absolute;z-index:12;top:22px;right:28px;display:flex;align-items:center;gap:8px;padding:8px 9px;border:1px solid var(--r1-line);border-radius:6px;background:#0f1215e8;color:var(--r1-gold);font-size:12px}
.r1-focus-chip span{font-variant-numeric:tabular-nums}.r1-focus-chip small{color:#899a90;font-size:11px}.r1-focus-chip button{display:grid;place-items:center;padding:3px;border:0;background:none;color:#a3b6aa}.r1-focus-chip button:disabled{opacity:.4}
.r1-shell[data-view=music] .r1-focus-chip{top:73px}
@media(max-width:1050px){.r1-has-side-panel .r1-focus-chip,.r1-has-wide-panel .r1-focus-chip{right:22px;top:15px}}
@media(max-width:760px){.r1-focus-chip{top:12px;right:15px;gap:5px;padding:5px}.r1-focus-chip small{display:none}}
</style>
