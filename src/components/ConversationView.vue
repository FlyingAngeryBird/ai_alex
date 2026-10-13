<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { AutoListenState, ParticleState, UiMessage } from '@/types/app'

const props = defineProps<{
  autoListenState: AutoListenState
  isListening: boolean
  messages: UiMessage[]
  partialText: string
  state: ParticleState
  temporaryMode: boolean
}>()

const panelCollapsed = defineModel<boolean>('collapsed', { default: false })

const messageListRef = ref<HTMLElement | null>(null)

// 展开状态下，messages 变化或 ASR 实时字幕变化时，自动滚动到最新对话
watch(
  [() => props.messages, () => props.partialText],
  () => {
    if (panelCollapsed.value) {
      return
    }

    void nextTick(() => {
      const el = messageListRef.value

      if (el) {
        el.scrollTop = el.scrollHeight
      }
    })
  }
)

const emit = defineEmits<{
  openItems: []
  openSearch: []
  toggleTemporary: []
  openSettings: []
  requestMusic: []
  toggleAutoListen: []
  voicePressEnd: []
  voicePressStart: []
}>()

function handleVoicePointerDown(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement | null
  target?.setPointerCapture?.(event.pointerId)
  emit('voicePressStart')
}

function handleVoicePointerEnd(event: PointerEvent): void {
  const target = event.currentTarget as HTMLElement | null
  if (target?.hasPointerCapture?.(event.pointerId)) {
    target.releasePointerCapture(event.pointerId)
  }
  emit('voicePressEnd')
}

function collapsePanel(): void {
  panelCollapsed.value = true
}

function expandPanel(): void {
  panelCollapsed.value = false
}

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
  arming: '准备中',
  armed: '自动开',
  prehearing: '识别中',
  recording: '聆听中',
  grace: '等你说完',
  speech_detected: '聆听中',
  finalizing: '整理中',
  paused_for_tts: '稍候',
  error: '需授权'
}
</script>

<template>
  <div class="conversation-panel" :data-collapsed="panelCollapsed" :data-state="state">
    <header v-if="!panelCollapsed" class="conversation-header">
      <div class="conversation-title">
        <p class="eyebrow">AI companion</p>
        <h1>Seamo AI</h1>
      </div>
      <div class="header-actions">
        <button class="panel-toggle" type="button" :aria-pressed="temporaryMode" @click="$emit('toggleTemporary')">{{ temporaryMode ? '退出临时' : '临时对话' }}</button>
        <button class="panel-toggle" type="button" @click="$emit('openItems')">事项</button>
        <button class="panel-toggle" type="button" @click="$emit('openSearch')">联网查询</button>
        <button class="panel-toggle" type="button" @click="$emit('openSettings')">设置</button>
        <button class="panel-toggle" type="button" @click="collapsePanel">收起</button>
        <div class="status-pill" :aria-label="`当前状态：${statusText[state]}`">
          <span class="status-dot" />
          {{ statusText[state] }}
        </div>
      </div>
    </header>

    <div v-if="!panelCollapsed" ref="messageListRef" class="message-list" aria-label="历史对话" aria-live="polite">
      <article
        v-for="message in messages"
        :key="message.id"
        class="message-row"
        :class="`message-row--${message.role}`"
      >
        <p>{{ message.text }}</p>
      </article>
      <article v-if="partialText" class="message-row message-row--partial">
        <p>{{ partialText }}</p>
      </article>
    </div>

    <footer v-if="!panelCollapsed" class="conversation-actions">
      <button
        class="space-cue"
        :class="{ 'space-cue--active': isListening }"
        type="button"
        @contextmenu.prevent
        @pointercancel.prevent="handleVoicePointerEnd"
        @pointerdown.prevent="handleVoicePointerDown"
        @pointerup.prevent="handleVoicePointerEnd"
      >
        <span>Space</span>
        <b>{{ isListening ? '松开发送' : '按住说话' }}</b>
      </button>
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
        <button class="icon-text-button" type="button" @click="$emit('requestMusic')">
          ♪ 播放音乐
        </button>
      </div>
    </footer>

    <footer v-else class="compact-action-bar" aria-label="灵粒快捷操作">
      <button class="compact-tab" type="button" :aria-pressed="temporaryMode" @click="$emit('toggleTemporary')">{{ temporaryMode ? '临时中' : '临时' }}</button>
      <button class="compact-tab" type="button" @click="$emit('openItems')">事项</button>
      <button class="compact-tab" type="button" @click="$emit('openSearch')">查询</button>
      <button
        class="compact-tab compact-voice"
        :class="{ 'compact-tab--active': isListening }"
        type="button"
        @contextmenu.prevent
        @pointercancel.prevent="handleVoicePointerEnd"
        @pointerdown.prevent="handleVoicePointerDown"
        @pointerup.prevent="handleVoicePointerEnd"
      >
        <span>Space</span>
        <b>{{ isListening ? '松开' : '说话' }}</b>
      </button>
      <button
        class="compact-tab"
        type="button"
        role="switch"
        :aria-checked="autoListenState !== 'off'"
        @click="$emit('toggleAutoListen')"
      >
        <span class="status-dot" />
        <b>{{ autoListenText[autoListenState] }}</b>
      </button>
      <div class="status-pill compact-status-pill" :aria-label="`当前状态：${statusText[state]}`">
        <span class="status-dot" />
        {{ statusText[state] }}
      </div>
      <button class="compact-tab" type="button" @click="$emit('requestMusic')">
        <span>♪</span>
        <b>播放</b>
      </button>
      <button class="compact-tab" type="button" @click="expandPanel">
        <span>⌃</span>
        <b>展开</b>
      </button>
    </footer>
  </div>
</template>
