<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArrowUp, MessageCircle, Mic, ShieldCheck, Square } from 'lucide-vue-next'
import type { AutoListenState } from '@/types/app'

const props = defineProps<{
  assistantName: string
  autoListenState: AutoListenState
  busy: boolean
  allowTextInterrupt?: boolean
  isListening: boolean
  temporaryMode: boolean
  serviceLabel: string
  musicActive: boolean
}>()
const emit = defineEmits<{
  send: [text: string, complete: (accepted: boolean) => void]
  voicePressStart: []
  voicePressEnd: []
  voicePressCancel: []
  toggleTemporary: []
  toggleAutoListen: []
  stopSpeech: []
  openServiceSettings: []
  layoutHeight: [extra: number]
}>()
const draft = ref('')
const error = ref('')
const inputElement = ref<HTMLTextAreaElement | null>(null)
const submitting = ref<string | null>(null)
function resizeInput(): void {
  const input = inputElement.value
  if (!input) return
  input.style.height = '24px'
  const height = Math.min(input.scrollHeight, 144)
  input.style.height = `${height}px`
  emit('layoutHeight', Math.max(0, height - 24))
}
watch(draft, () => { void nextTick(resizeInput) })
let heldPointer: number | null = null
let enterHeld = false

function focusInput(): void {
  inputElement.value?.focus()
}

defineExpose({ focusInput })

function submit(): void {
  const text = draft.value.trim()
  if (submitting.value !== null || !text || props.busy && !props.allowTextInterrupt || props.isListening) return
  if ([...text].length > 8000) {
    error.value = '一次最多发送 8000 个字符；请缩短后重试。'
    return
  }
  error.value = ''
  submitting.value = text
  emit('send', text, (accepted) => {
    if (submitting.value === text) submitting.value = null
    if (accepted && draft.value.trim() === text) draft.value = ''
  })
}

function onEnter(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) { event.preventDefault(); return }
  if (event.shiftKey) return
  event.preventDefault()
  if (!event.repeat) submit()
}

function pressPointer(event: PointerEvent): void {
  if (!event.isPrimary || event.button !== 0 || heldPointer !== null || enterHeld) return
  event.preventDefault()
  heldPointer = event.pointerId
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  emit('voicePressStart')
}
function releasePointer(event: PointerEvent): void {
  if (heldPointer !== event.pointerId) return
  heldPointer = null
  emit('voicePressEnd')
}
function cancelPointer(event: PointerEvent): void {
  if (heldPointer !== event.pointerId) return
  heldPointer = null
  emit('voicePressCancel')
}
function pressEnter(event: KeyboardEvent): void {
  if (event.repeat || enterHeld || heldPointer !== null) return
  enterHeld = true
  emit('voicePressStart')
}
function releaseEnter(): void {
  if (!enterHeld) return
  enterHeld = false
  emit('voicePressEnd')
}
function cancelHeldInput(): void {
  if (heldPointer === null && !enterHeld) return
  heldPointer = null
  enterHeld = false
  emit('voicePressCancel')
}
function handleVisibility(): void { if (document.hidden) cancelHeldInput() }
onMounted(() => {
  void nextTick(resizeInput)
  window.addEventListener('blur', cancelHeldInput)
  document.addEventListener('visibilitychange', handleVisibility)
})
onBeforeUnmount(() => {
  window.removeEventListener('blur', cancelHeldInput)
  document.removeEventListener('visibilitychange', handleVisibility)
  cancelHeldInput()
})
</script>

<template>
  <div class="r1-composer-area" :class="{ 'r1-composer-music': musicActive }">
    <form class="r1-composer" @submit.prevent="submit">
      <button class="r1-microphone" type="button" :aria-label="isListening ? '松开发送语音' : '按住说话，松开发送'"
        @pointerdown="pressPointer" @pointerup="releasePointer" @pointercancel="cancelPointer"
        @lostpointercapture="cancelPointer" @keydown.enter.prevent="pressEnter" @keyup.enter.prevent="releaseEnter">
        <Square v-if="isListening" :size="17" /><Mic v-else :size="19" />
      </button>
      <textarea ref="inputElement" rows="1" v-model="draft" aria-label="对话输入" :placeholder="`和 ${assistantName} 说点什么…`"
        autocomplete="off" title="Enter 发送，Shift+Enter 换行" @keydown.enter="onEnter"></textarea>
      <button v-if="busy" type="button" class="r1-stop" aria-label="停止回答" @click="emit('stopSpeech')"><Square :size="15" /></button>
      <button class="r1-send" type="submit" aria-label="发送消息" :disabled="submitting !== null || !draft.trim() || busy && !allowTextInterrupt || isListening"><ArrowUp :size="20" /></button>
    </form>
    <p v-if="error" class="r1-composer-error" role="alert">{{ error }}</p>
    <div class="r1-composer-foot">
      <button type="button" class="r1-mode" :aria-pressed="temporaryMode" title="切换普通或临时对话" @click="emit('toggleTemporary')">
        <ShieldCheck v-if="temporaryMode" :size="13" /><MessageCircle v-else :size="13" />
        {{ temporaryMode ? '临时对话' : '普通对话' }}
      </button>
      <button type="button" class="r1-auto" :aria-pressed="autoListenState !== 'off'"
        @click="emit('toggleAutoListen')">{{ autoListenState === 'off' ? '开启自动会话' : '关闭自动会话' }}</button>
      <button type="button" class="r1-service-status" @click="emit('openServiceSettings')">{{ serviceLabel }}</button>
    </div>
  </div>
</template>
