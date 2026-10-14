<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { MemoryConfirmation } from '../../electron/main/r1/memoryConfirmations'
defineProps<{ confirmation: MemoryConfirmation; busy: boolean; error: string }>()
const emit = defineEmits<{ confirm: []; cancel: []; selection: [input: { content: string; category: 'profile' | 'preference' | 'ongoing' | 'conclusion' }] }>()
const selectedContent = ref('')
const category = ref<'profile' | 'preference' | 'ongoing' | 'conclusion'>('profile')
const dialog = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
onMounted(() => { previousFocus = document.activeElement as HTMLElement | null; dialog.value?.focus() })
onBeforeUnmount(() => { if (previousFocus?.isConnected) previousFocus.focus() })
function trapFocus(event: KeyboardEvent): void {
  const buttons = [...dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), select:not(:disabled)') ?? []]
  if (!buttons.length) { event.preventDefault(); return }
  const first = buttons[0], last = buttons.at(-1)!
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.value)) { event.preventDefault(); first.focus() }
}
</script>
<template>
  <div class="r1-memory-modal-backdrop r1-memory-confirmation-backdrop" role="presentation" @click.self="!busy && emit('cancel')">
    <section ref="dialog" class="r1-memory-modal r1-memory-confirmation" role="alertdialog" aria-modal="true"
      aria-labelledby="memory-confirm-title" aria-describedby="memory-confirm-scope" tabindex="-1"
      @keydown.esc.prevent="!busy && emit('cancel')" @keydown.tab="trapFocus">
      <h3 id="memory-confirm-title">{{ confirmation.requiresSelection ? '选择要记住的一件事' : confirmation.operation === 'update' ? '更正这段记忆？' : '保存这件事？' }}</h3>
      <p class="r1-confirmed-memory-content">{{ confirmation.content }}</p>
      <template v-if="confirmation.requiresSelection">
        <label for="memory-selected-content">从上面的原话中选取一件明确的事</label>
        <textarea id="memory-selected-content" v-model="selectedContent" :disabled="busy" maxlength="1000" rows="3" placeholder="粘贴原话中想保存的那一段" />
        <label for="memory-selected-category">类别</label>
        <select id="memory-selected-category" v-model="category" :disabled="busy"><option value="profile">关于我</option><option value="preference">偏好</option><option value="ongoing">近况</option><option value="conclusion">共同结论</option></select>
      </template>
      <p id="memory-confirm-scope" v-if="confirmation.requiresSelection">这轮话可能涉及敏感信息，目前没有自动保存。下一步会显示你选中的内容，再由你确认保存。</p>
      <p v-else id="memory-confirm-scope">{{ confirmation.temporary
        ? '当前是临时对话。确认后将退出临时对话，并把这段内容保存到长期记忆。其余临时聊天会清除。'
        : '这段内容会保存到长期记忆，用于后续对话；你可以在记忆中查看来源、更正或忘记。' }}</p>
      <p v-if="confirmation.sensitive && !confirmation.requiresSelection">这条记忆涉及敏感信息。只在你确认后保存上面这段内容。</p>
      <p v-if="confirmation.validUntil">有效期至 {{ new Date(confirmation.validUntil).toLocaleString('zh-CN') }}。</p>
      <div class="r1-memory-dialog-actions">
        <button type="button" :disabled="busy" @click="emit('cancel')">{{ confirmation.temporary ? '继续临时对话' : '不保存' }}</button>
        <button v-if="confirmation.requiresSelection" type="button" :disabled="busy || !selectedContent.trim()" @click="emit('selection', { content: selectedContent, category })">{{ busy ? '正在准备…' : '查看保存范围' }}</button>
        <button v-else type="button" :disabled="busy" @click="emit('confirm')">{{ busy ? '正在保存…' : '确认保存' }}</button>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
    </section>
  </div>
</template>
<style scoped>
.r1-memory-confirmation-backdrop { z-index: 60; }
.r1-confirmed-memory-content { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 35vh; overflow-y: auto; color: #edf0e7 !important; }
.r1-memory-confirmation textarea, .r1-memory-confirmation select { width: 100%; background: #18201e; border: 1px solid var(--r1-line); border-radius: 5px; padding: 8px; color: var(--r1-text); font: inherit; margin: 6px 0 12px; }
.r1-memory-confirmation label { color: var(--r1-muted); font-size: 12px; }
</style>
