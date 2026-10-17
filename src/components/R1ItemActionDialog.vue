<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

type ItemActionReminderView = { reminderId: string; scheduleVersion: number; status: string }
const props = defineProps<{
  action: 'confirm_item_delete' | 'export'
  itemTitle: string
  reminders?: ItemActionReminderView[]
  items?: { itemId: string; title: string; version: number }[]
  artifactTitle?: string
  format?: 'txt' | 'md'
  busy: boolean
  error: string
  expiresAt?: string
}>()
const emit = defineEmits<{ close: []; keep: []; cancelReminders: []; export: [] }>()
const dialog = ref<HTMLElement | null>(null)
let previousFocus: HTMLElement | null = null
const scheduled = () => (props.reminders ?? []).filter(reminder => reminder.status === 'scheduled').length
const exportLabel = () => props.artifactTitle ? `工作稿「${props.artifactTitle}」`
  : (props.items?.length ?? 0) > 1 ? `${props.items!.length} 条事项` : (props.items?.[0]?.title ?? props.itemTitle)
onMounted(() => { previousFocus = document.activeElement as HTMLElement | null; dialog.value?.focus() })
onBeforeUnmount(() => { if (previousFocus?.isConnected) previousFocus.focus() })
</script>

<template>
  <div class="r1-memory-modal-backdrop" role="presentation" @click.self="!busy && emit('close')">
    <section ref="dialog" class="r1-memory-modal r1-item-action-modal" role="alertdialog" aria-modal="true"
      :aria-label="action === 'confirm_item_delete' ? '确认删除事项' : '确认导出'" tabindex="-1"
      @keydown.esc.prevent="!busy && emit('close')">
      <template v-if="action === 'confirm_item_delete'">
        <small>YOUR THINGS</small>
        <h3>删除这件事？</h3>
        <p>{{ itemTitle }}</p>
        <p v-if="(reminders ?? []).length">关联的 {{ (reminders ?? []).length }} 条提醒默认保留；也可以主动取消尚未到期的提醒。提醒怎么处理只由你在这里选择。</p>
        <div class="r1-memory-dialog-actions">
          <button type="button" :disabled="busy" @click="emit('close')">保留事项</button>
          <button type="button" :disabled="busy" @click="emit('keep')">{{ busy ? '正在删除…' : '只删事项' }}</button>
          <button v-if="scheduled()" type="button" :disabled="busy" @click="emit('cancelReminders')">连提醒一起取消</button>
        </div>
      </template>
      <template v-else>
        <small>YOUR THINGS</small>
        <h3>导出这个版本？</h3>
        <p>{{ exportLabel() }}</p>
        <p>下一步才会打开系统保存位置，由你选择文件放哪里；取消不会写出文件。</p>
        <p v-if="format">格式：{{ format === 'md' ? 'Markdown' : '纯文本 TXT' }}</p>
        <div class="r1-memory-dialog-actions">
          <button type="button" :disabled="busy" @click="emit('close')">取消</button>
          <button type="button" :disabled="busy" @click="emit('export')">{{ busy ? '正在导出…' : '选择保存位置' }}</button>
        </div>
      </template>
      <p v-if="expiresAt" class="r1-item-action-expiry">这次确认在 {{ new Date(expiresAt).toLocaleTimeString('zh-CN') }} 前有效；过期需重新发起。</p>
      <p v-if="error" role="alert">{{ error }}</p>
    </section>
  </div>
</template>

<style scoped>
.r1-item-action-modal { max-height: calc(100vh - 48px); overflow: auto; }
.r1-item-action-modal small { color: #80968a; font-size: 9px; letter-spacing: .1em; }
.r1-item-action-modal .r1-memory-dialog-actions { flex-wrap: wrap; }
.r1-item-action-modal p { overflow-wrap: anywhere; }
.r1-item-action-expiry { color: #8d9d93; font-size: 11px; }
</style>
