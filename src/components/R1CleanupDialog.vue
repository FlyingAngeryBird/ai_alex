<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import type { CleanupPreview } from '../../electron/main/r1/dataManagement'
const props = defineProps<{ preview: CleanupPreview; busy: boolean; error?: string }>()
const emit = defineEmits<{ cancel: []; confirm: [] }>()
const dialog = ref<HTMLElement | null>(null)
const previous = document.activeElement as HTMLElement | null
const ranges = computed(() => {
  const c = props.preview.counts
  return props.preview.selection.scopes.map(scope => ({
    history: `对话历史：${props.preview.selection.sessionId ? '所选1段' : c.sessions+'段'}，${c.messages}条消息`,
    memory: `独立记忆与持续话题：${c.memories}条记忆、${c.topics}个话题`,
    items: `事项、提醒与专注：${c.items}条事项、${c.reminders}条提醒`,
    music: `音乐个人数据：${c.favorites}首收藏、${c.queue}项队列、${c.feedback}条反馈`,
    work: `任务与工作稿：${c.tasks}个任务、${c.artifacts}份工作稿`
  })[scope])
})
function keys(event: KeyboardEvent) {
  if (event.key === 'Escape' && !props.busy) { emit('cancel'); return }
  if (event.key !== 'Tab') return
  const buttons = [...dialog.value!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
  const first=buttons[0], last=buttons.at(-1)
  if (!first) { event.preventDefault(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.value)) { event.preventDefault(); first.focus() }
}
onMounted(() => dialog.value?.focus())
onBeforeUnmount(() => previous?.isConnected && previous.focus())
</script>
<template>
  <Teleport to="body"><div class="r1-memory-modal-backdrop" style="position:fixed;z-index:100" @keydown.stop="keys">
    <section ref="dialog" class="r1-memory-modal" role="dialog" aria-modal="true" aria-labelledby="r1-cleanup-title" tabindex="-1">
      <h3 id="r1-cleanup-title">确认清理所选内容</h3>
      <ul><li v-for="range in ranges" :key="range">{{ range }}</li></ul>
      <p>停止服务后先保存清理前副本，再清理并重启。清理后可在数据设置导出该副本并恢复。</p>
      <p v-if="preview.selection.scopes.includes('history')">清理历史不删除独立记忆、事项或工作稿；已删除对话的原始来源将不可查看。</p>
      <p v-if="preview.selection.scopes.includes('memory')">记忆与话题将被遗忘；恢复旧备份仍保留遗忘抑制。自动记忆授权保持原选择，只对之后的新内容生效。</p>
      <p v-if="preview.selection.scopes.includes('items')">所选范围包含提醒及专注，未投递提醒将不再触发。已发送的系统通知不会被撤回。</p>
      <p>未选范围及服务凭据保留。未完成任务不会自动重放；原始对话已清理的任务可能需要重新提出。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <div class="r1-memory-dialog-actions"><button type="button" :disabled="busy" @click="emit('cancel')">取消</button><button type="button" :disabled="busy" @click="emit('confirm')">确认清理并重启</button></div>
    </section>
  </div></Teleport>
</template>
<style scoped>.r1-memory-modal:focus-visible{outline:2px solid var(--r1-aqua);outline-offset:3px}.r1-memory-modal{max-height:calc(100vh - 40px);overflow:auto}ul{padding-left:20px;color:var(--r1-aqua);font-size:13px;line-height:1.9}p{font-size:12px;line-height:1.8}</style>
