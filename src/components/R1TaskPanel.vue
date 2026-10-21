<script setup lang="ts">
import R1WebResult from './R1WebResult.vue'
import R1ArtifactEditor from './R1ArtifactEditor.vue'
import { Pause, Play, X } from 'lucide-vue-next'
import { ref, watch } from 'vue'
import type { R1Task, TaskStatus } from '../../electron/main/r1/taskSupervisor'
const props = defineProps<{ tasks: R1Task[]; selected: R1Task | null; busy: boolean; error: string; loading: boolean; active?: boolean }>()
const editors = new Map<string, { flush(): Promise<boolean> }>()
function editorRef(key: string, value: unknown): void {
  if (value) editors.set(key, value as { flush(): Promise<boolean> })
  else editors.delete(key)
}
async function flushOnce(): Promise<boolean> {
  const selected = props.selected
  if (!selected) return true
  for (const artifact of selected.result?.artifacts ?? []) {
    const editor = editors.get(`${selected.taskId}:${artifact.artifactId}`)
    if (editor && !await editor.flush()) return false
  }
  return true
}
async function flushEditing(): Promise<boolean> {
  if (await flushOnce()) return true
  // The debounced apply may still be settling; re-check once before telling the user it is unsaved.
  await new Promise(resolve => setTimeout(resolve, 250))
  return await flushOnce()
}
const selecting = ref(false)
const selectionError = ref('')
async function selectTask(event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement, next = select.value
  select.value = props.selected?.taskId ?? ''
  if (selecting.value) return
  selecting.value = true; selectionError.value = ''
  try {
    if (await flushEditing()) emit('select', next)
    else selectionError.value = '工作稿尚未保存，请先保存或撤销，再切换委托。'
  } catch { selectionError.value = '工作稿暂时无法保存，当前内容已保留。' }
  finally { selecting.value = false }
}
defineExpose({ flushEditing })
// Best-effort persistence when the panel hides because of sidebar/view navigation.
watch(() => props.active, active => { if (active === false) void flushEditing() })
const emit = defineEmits<{ close: []; select: [id: string]; control: [action: 'pause' | 'resume' | 'cancel']; retry: [] }>()
const labels: Record<TaskStatus, string> = { accepted: '等待处理', running: '正在处理', waiting_input: '等待补充',
  paused: '已暂停', needs_resume: '等待继续', succeeded: '已完成', partially_succeeded: '部分完成', failed: '未完成', cancelled: '已取消' }
</script>
<template>
  <aside class="r1-basic-side r1-task-panel" aria-label="任务结果">
    <header><div><small>SEAMO / YOUR REQUEST</small><h2>这次的委托</h2></div>
      <button type="button" aria-label="关闭任务结果" @click="emit('close')"><X :size="19" /></button></header>
    <div class="r1-basic-content">
      <p v-if="error" role="alert">{{ error }} <button type="button" @click="emit('retry')">重试</button></p>
      <p v-if="loading && !tasks.length" role="status">正在读取…</p>
      <label v-if="tasks.length > 1" class="r1-task-picker">查看委托
        <select :value="selected?.taskId || ''" :disabled="selecting" @change="selectTask">
          <option disabled value="">选择一项委托</option><option v-for="task in tasks" :key="task.taskId" :value="task.taskId">{{ task.goal }}</option>
        </select>
      </label>
      <p v-if="selectionError" role="alert">{{ selectionError }}</p>
      <template v-if="selected">
        <section><small>当前条件</small><p class="task-goal">{{ selected.goal }}</p>
          <ul v-if="selected.constraints.length"><li v-for="condition in selected.constraints" :key="condition">{{ condition }}</li></ul></section>
        <section class="task-status" aria-live="polite"><h3>{{ labels[selected.status] }}</h3><p>{{ selected.progressBrief }}</p>
          <p v-if="selected.queuePosition !== null">队列位置 {{ selected.queuePosition }}</p></section>
        <div class="task-actions">
          <button v-if="['accepted','running'].includes(selected.status)" type="button" :disabled="busy" @click="emit('control', 'pause')"><Pause :size="14" />暂停</button>
          <button v-if="['paused','needs_resume','waiting_input','partially_succeeded'].includes(selected.status)" type="button" :disabled="busy" @click="emit('control', 'resume')"><Play :size="14" />{{ selected.status === 'partially_succeeded' ? '继续未完成步骤' : '继续' }}</button>
          <button v-if="['accepted','running','paused','needs_resume','waiting_input'].includes(selected.status)" type="button" :disabled="busy" @click="emit('control', 'cancel')"><X :size="14" />取消任务</button>
        </div>
        <R1WebResult :task="selected" />
        <template v-if="selected.result"><p class="task-summary">{{ selected.result.replyBrief }}</p>
          
          <p v-for="(issue, index) in selected.result.unresolved" :key="index">{{ issue }}</p>
          <article v-for="receipt in selected.result.entityReceipts" :key="receipt.actionId"><small>{{ receipt.status === 'succeeded' ? '已执行' : receipt.status === 'unknown' ? '待核验' : receipt.status === 'cancelled' ? '已取消' : '未成功' }}</small><p>{{ receipt.summary }}</p></article>
        </template>
      </template>
      <p v-else-if="!loading && !tasks.length">当前没有委托。</p>
      <div v-for="task in tasks" v-show="selected?.taskId === task.taskId" :key="task.taskId">
        <R1ArtifactEditor v-for="artifact in task.result?.artifacts || []" :key="artifact.artifactId" :ref="value => editorRef(`${task.taskId}:${artifact.artifactId}`, value)" :artifact-id="artifact.artifactId" :active="!!active && selected?.taskId === task.taskId && task.result?.artifacts.length === 1" />
      </div>
    </div>
  </aside>
</template>
<style scoped>
.r1-task-panel{width:min(720px,58vw)}
section{padding:16px 0;border-bottom:1px solid var(--r1-line)}section small{color:#89978f;font-size:11px}p,li{font-size:13px;line-height:1.8;color:#b1bcb7}h3{font-size:16px;font-weight:500}.task-goal,.task-body{white-space:pre-wrap;overflow-wrap:anywhere}.task-actions{display:flex;gap:18px;margin:20px 0}.task-actions button{display:flex;gap:6px;align-items:center;border:0;background:none;color:var(--r1-aqua);font-size:12px}.task-actions button:disabled{opacity:.45}.r1-task-picker{display:flex;gap:10px;align-items:center;font-size:12px;color:#89978f}.r1-task-picker select{min-width:0;flex:1;background:#171d20;border:1px solid var(--r1-line);color:var(--r1-text);padding:8px}.task-summary{margin-top:24px}
@media(max-width:1050px){.r1-task-panel{width:calc(100% - var(--r1-rail))}}
</style>
