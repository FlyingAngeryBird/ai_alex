<script setup lang="ts">
import { ref } from 'vue'
import { ArrowUp, ChevronDown, MessageCircle, Mic, ShieldCheck, Square } from 'lucide-vue-next'
import type { AutoListenState } from '@/types/app'

const props = defineProps<{
  autoListenState: AutoListenState
  busy: boolean
  isListening: boolean
  temporaryMode: boolean
  serviceLabel: string
  musicActive: boolean
}>()
const emit = defineEmits<{
  send: [text: string, complete: (accepted: boolean) => void]
  voicePressStart: []
  voicePressEnd: []
  toggleTemporary: []
  toggleAutoListen: []
  stopSpeech: []
}>()
const draft = ref('')
const error = ref('')
const inputElement = ref<HTMLInputElement | null>(null)

function focusInput(): void {
  inputElement.value?.focus()
}

defineExpose({ focusInput })

function submit(): void {
  const text = draft.value.trim()
  if (!text || props.busy || props.isListening) return
  if ([...text].length > 8000) {
    error.value = '一次最多发送 8000 个字符；请缩短后重试。'
    return
  }
  error.value = ''
  emit('send', text, (accepted) => {
    if (accepted && draft.value.trim() === text) draft.value = ''
  })
}

function onEnter(event: KeyboardEvent): void {
  if (event.isComposing) { event.preventDefault(); return }
  submit()
}

function toggleVoice(): void {
  if (props.isListening) emit('voicePressEnd')
  else emit('voicePressStart')
}
</script>

<template>
  <div class="r1-composer-area" :class="{ 'r1-composer-music': musicActive }">
    <form class="r1-composer" @submit.prevent="submit">
      <button class="r1-microphone" type="button" :aria-label="isListening ? '结束并发送语音' : '开始语音输入'"
        @click="toggleVoice">
        <Square v-if="isListening" :size="17" /><Mic v-else :size="19" />
      </button>
      <input ref="inputElement" v-model="draft" aria-label="对话输入" placeholder="和 Seamo AI 说点什么…"
        autocomplete="off" @keydown.enter="onEnter" />
      <button v-if="busy" type="button" class="r1-stop" aria-label="停止朗读" @click="emit('stopSpeech')"><Square :size="15" /></button>
      <button class="r1-send" type="submit" aria-label="发送消息" :disabled="!draft.trim() || busy || isListening"><ArrowUp :size="20" /></button>
    </form>
    <p v-if="error" class="r1-composer-error" role="alert">{{ error }}</p>
    <div class="r1-composer-foot">
      <button type="button" class="r1-mode" @click="emit('toggleTemporary')">
        <ShieldCheck v-if="temporaryMode" :size="13" /><MessageCircle v-else :size="13" />
        {{ temporaryMode ? '临时对话' : '普通对话' }}<ChevronDown :size="11" />
      </button>
      <button type="button" class="r1-auto" :aria-pressed="autoListenState !== 'off'"
        @click="emit('toggleAutoListen')">{{ autoListenState === 'off' ? '开启自动会话' : '关闭自动会话' }}</button>
      <span>{{ serviceLabel }}</span>
    </div>
  </div>
</template>
