<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { MemoryConfirmation } from '../../electron/main/r1/memoryConfirmations'
defineProps<{ confirmation: MemoryConfirmation; busy: boolean; error: string }>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const dialog = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
onMounted(() => { previousFocus = document.activeElement as HTMLElement | null; dialog.value?.focus() })
onBeforeUnmount(() => { if (previousFocus?.isConnected) previousFocus.focus() })
function trapFocus(event: KeyboardEvent): void {
  const buttons = [...dialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []]
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
      <h3 id="memory-confirm-title">{{ confirmation.operation === 'update' ? '更正这段记忆？' : '保存这件事？' }}</h3>
      <p class="r1-confirmed-memory-content">{{ confirmation.content }}</p>
      <p id="memory-confirm-scope">{{ confirmation.temporary
        ? '当前是临时对话。确认后将退出临时对话，并把这段内容保存到长期记忆。其余临时聊天会清除。'
        : '这段内容会保存到长期记忆，用于后续对话；你可以在记忆中查看来源、更正或忘记。' }}</p>
      <p v-if="confirmation.sensitive">这条记忆涉及敏感信息。只在你确认后保存上面这段内容。</p>
      <p v-if="confirmation.validUntil">有效期至 {{ new Date(confirmation.validUntil).toLocaleString('zh-CN') }}。</p>
      <div class="r1-memory-dialog-actions">
        <button type="button" :disabled="busy" @click="emit('cancel')">{{ confirmation.temporary ? '继续临时对话' : '不保存' }}</button>
        <button type="button" :disabled="busy" @click="emit('confirm')">{{ busy ? '正在保存…' : '确认保存' }}</button>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
    </section>
  </div>
</template>
<style scoped>
.r1-memory-confirmation-backdrop { z-index: 60; }
.r1-confirmed-memory-content { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 35vh; overflow-y: auto; color: #edf0e7 !important; }
</style>
