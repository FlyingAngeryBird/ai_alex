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
</script>

<template>
  <div class="conversation-panel" :data-state="state">
    <header class="conversation-header">
      <div>
        <p class="eyebrow">Lingli</p>
        <h1>灵粒</h1>
      </div>
      <div class="status-pill" :aria-label="`当前状态：${statusText[state]}`">
        <span class="status-dot" />
        {{ statusText[state] }}
      </div>
    </header>

    <div class="message-list" aria-live="polite">
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
          <b>{{ autoListenState === 'speech_detected' ? '聆听中' : autoListenState === 'off' ? '自动聆听' : '自动开' }}</b>
        </button>
        <button class="icon-text-button" type="button" @click="$emit('demoMusic')">
          ♪ 演示音乐页
        </button>
      </div>
    </footer>
  </div>
</template>
