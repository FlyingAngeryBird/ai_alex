<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowRight, Globe, History, MessageCircle } from 'lucide-vue-next'
import type { ParticleState, UiMessage } from '@/types/app'

const props = defineProps<{
  messages: UiMessage[]
  partialText: string
  state: ParticleState
  temporaryMode: boolean
}>()
const emit = defineEmits<{ openHistory: []; openSearch: []; startChat: [] }>()
const expanded = ref(false)
const replyExpanded = ref(false)
const dialogue = computed(() => props.messages.filter((message) => message.role !== 'system'))
const latestUser = computed(() => [...props.messages].reverse().find((message) => message.role === 'user'))
const latestResponse = computed(() => [...props.messages].reverse().find((message) => message.role === 'assistant'))
const latestError = computed(() => props.messages.at(-1)?.role === 'system'
  ? props.messages.at(-1) : null)
const replyIsLong = computed(() => {
  const text = latestResponse.value?.text ?? ''
  return [...text].length > 67 || text.includes('\n')
})
const recentMessages = computed(() => dialogue.value.slice(-6))
const statusLabel: Record<ParticleState, string> = {
  idle: '在这里', listening: '正在听', thinking: '正在想', speaking: '正在说',
  playing: '音乐陪伴', error: '需要检查'
}
</script>

<template>
  <section class="r1-conversation" :data-expanded="replyExpanded || expanded" aria-label="当前对话">
    <div class="r1-conversation-copy" aria-live="polite">
      <span class="r1-presence"><i :data-state="state" />{{ temporaryMode ? '临时对话' : statusLabel[state] }}<b>/</b>Seamo AI</span>
      <button v-if="recentMessages.length > 2" class="r1-recent-toggle" type="button"
        :aria-expanded="expanded" @click="expanded = !expanded">
        <History :size="13" />{{ expanded ? '收起最近对话' : '查看最近对话' }}
      </button>
      <div v-if="expanded" class="r1-recent-dialogue">
        <p v-for="message in recentMessages" :key="message.id">
          <small>{{ message.role === 'user' ? '你' : 'Seamo AI' }}</small>{{ message.text }}
        </p>
        <button type="button" @click="emit('openHistory')">查看全部对话 <ArrowRight :size="13" /></button>
      </div>
      <p v-if="partialText" class="r1-user-line">{{ partialText }}</p>
      <p v-else-if="latestUser" class="r1-user-line">{{ latestUser.text }}</p>
      <h1 class="r1-current-reply" :class="{ pending: state === 'thinking', long: replyIsLong, expanded: replyExpanded }">
        {{ latestResponse?.text || (state === 'listening' ? '嗯，你说。' : '想聊什么？我在这里。') }}
      </h1>
      <button v-if="replyIsLong" class="r1-expand-reply" type="button" :aria-expanded="replyExpanded"
        @click="replyExpanded = !replyExpanded">{{ replyExpanded ? '收起全文' : '展开全文' }}</button>
      <p v-if="latestError" class="r1-inline-error" role="status">{{ latestError.text }}</p>
    </div>
    <div v-if="!latestUser && !temporaryMode" class="r1-starters">
      <button type="button" @click="emit('startChat')"><MessageCircle :size="15" />聊聊今天</button>
      <button type="button" @click="emit('openSearch')"><Globe :size="15" />查个现实问题</button>
    </div>
  </section>
</template>
