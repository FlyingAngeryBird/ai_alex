<script setup lang="ts">
import type { AutoListenState, ParticleState, UiMessage } from '@/types/app'

defineProps<{
  autoListenState: AutoListenState
  isListening: boolean
  messages: UiMessage[]
  state: ParticleState
}>()

defineEmits<{
  demoMusic: []
  toggleAutoListen: []
}>()

const statusText: Record<ParticleState, string> = {
  idle: '待机',
  listening: '聆听',
  thinking: '思考',
  speaking: '回应',
  playing: '播放',
  error: '异常'
}

const autoListenText: Record<AutoListenState, string> = {
  off: '自动聆听',
  armed: '自动开',
  speech_detected: '聆听中',
  finalizing: '整理中',
  paused_for_tts: '稍候',
  error: '需授权'
}
</script>

<template>
  <div class="conversation-panel" :data-state="state">
    <header class="conversation-header">
      <div>
        <p class="eyebrow">AI companion</p>
        <h1>lingmo</h1>
      </div>
      <div class="status-pill" :aria-label="`当前状态：${statusText[state]}`">
        <span class="status-dot" />
        {{ statusText[state] }}
      </div>
    </header>

    <div class="message-list" aria-label="历史对话" aria-live="polite">
      <article
        v-for="message in messages"
        :key="message.id"
        class="message-row"
        :class="`message-row--${message.role}`"
      >
        <p>{{ message.text }}</p>
      </article>
    </div>

    <footer class="conversation-actions">
      <div class="space-cue" :class="{ 'space-cue--active': isListening }">
        <span>Space</span>
        <b>{{ isListening ? '松开发送' : '按住说话' }}</b>
      </div>
      <div class="action-cluster">
        <button
          class="auto-listen-toggle"
          type="button"
          role="switch"
          :aria-checked="autoListenState !== 'off'"
          @click="$emit('toggleAutoListen')"
        >
          <span class="switch-track"><span class="switch-thumb" /></span>
          <b>{{ autoListenText[autoListenState] }}</b>
        </button>
        <button class="icon-text-button" type="button" @click="$emit('demoMusic')">
          ♪ 演示音乐页
        </button>
      </div>
    </footer>
  </div>
</template>
