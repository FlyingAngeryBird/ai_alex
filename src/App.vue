<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ConversationView from '@/components/ConversationView.vue'
import MiniPlayer from '@/components/MiniPlayer.vue'
import MusicImmersiveView from '@/components/MusicImmersiveView.vue'
import ParticleSphere from '@/components/ParticleSphere.vue'
import { useAutoListen } from '@/composables/useAutoListen'
import { useConversation } from '@/composables/useConversation'
import { useKeyboardRecorder } from '@/composables/useKeyboardRecorder'
import { useMusic } from '@/composables/useMusic'
import type { ParticleState } from '@/types/app'

const conversation = useConversation()
const keyboardRecorder = useKeyboardRecorder()
const music = useMusic()
const spaceHeld = ref(false)
const viewMode = computed(() => music.viewMode.value)
const autoDetectableStates = new Set(['armed', 'speech_detected'])

const autoListen = useAutoListen({
  canDetect: () =>
    music.viewMode.value === 'conversation' &&
    !spaceHeld.value &&
    autoDetectableStates.has(conversation.autoListenState.value),
  onSpeechStart: async () => {
    if (conversation.autoListenState.value !== 'armed' || music.viewMode.value !== 'conversation') {
      return
    }

    await startVoiceCapture()
  },
  onSpeechEnd: async () => {
    if (!conversation.isListening.value || music.viewMode.value !== 'conversation') {
      return
    }

    await finishVoiceCapture('我刚刚开口说话了')
  }
})

const particleState = computed<ParticleState>(() => {
  if (music.viewMode.value === 'music' && music.playback.value.status !== 'error') {
    return music.playback.value.status === 'paused' ? 'idle' : 'playing'
  }

  if (music.playback.value.status === 'playing' && conversation.particleState.value === 'idle') {
    return 'playing'
  }

  return conversation.particleState.value
})

const audioLevel = computed(() => {
  if (particleState.value === 'playing') {
    const position = music.playback.value.positionMs / 1000
    return 0.34 + Math.abs(Math.sin(position * 1.7)) * 0.36
  }

  if (autoListen.enabled.value && autoDetectableStates.has(conversation.autoListenState.value)) {
    return Math.max(conversation.audioLevel.value, Math.min(0.48, autoListen.level.value * 2.4))
  }

  return conversation.audioLevel.value
})

async function runMusicDemo(): Promise<void> {
  const result = await conversation.sendMusicDemoRequest()
  if (result.intent === 'play_music') {
    music.startDemoTrack()
  }
}

async function startVoiceCapture(): Promise<void> {
  try {
    await keyboardRecorder.start()
  } catch {
    // Keep the prototype interactive even before Electron voice services are fully configured.
  }

  conversation.startListening()
}

async function finishVoiceCapture(fallbackText = '我想和你聊聊今天的心情'): Promise<void> {
  let text = fallbackText

  if (keyboardRecorder.isRecording.value) {
    try {
      const transcription = await keyboardRecorder.stopAndTranscribe()
      text = transcription.text || fallbackText
    } catch {
      text = fallbackText
    }
  }

  const result = await conversation.stopListening(text)
  if (result.intent === 'play_music') {
    music.startDemoTrack()
  }
}

async function toggleAutoListen(): Promise<void> {
  if (conversation.autoListenState.value === 'off' || conversation.autoListenState.value === 'error') {
    const didStart = await autoListen.start()
    if (didStart) {
      conversation.enableAutoListen()
    } else {
      conversation.markAutoListenError()
    }
    return
  }

  autoListen.stop()
  conversation.disableAutoListen()
}

async function handleKeyUp(event: KeyboardEvent): Promise<void> {
  if (event.code !== 'Space' || !spaceHeld.value) {
    return
  }

  event.preventDefault()
  spaceHeld.value = false

  await finishVoiceCapture()
}

async function handleKeyDown(event: KeyboardEvent): Promise<void> {
  if (event.code !== 'Space' || event.repeat || music.viewMode.value !== 'conversation') {
    return
  }

  event.preventDefault()
  spaceHeld.value = true
  await startVoiceCapture()
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  autoListen.stop()
})
</script>

<template>
  <main class="app-shell" :data-view="viewMode">
    <ParticleSphere class="particle-stage" :state="particleState" :audio-level="audioLevel" />

    <Transition name="view-fade" mode="out-in">
      <MusicImmersiveView
        v-if="viewMode === 'music'"
        :playback="music.playback.value"
        @back="music.closeImmersive"
        @toggle-playback="music.togglePlayback"
      />
      <section v-else class="conversation-stage">
        <ConversationView
          :messages="conversation.messages.value"
          :state="conversation.particleState.value"
          :auto-listen-state="conversation.autoListenState.value"
          :is-listening="conversation.isListening.value"
          @demo-music="runMusicDemo"
          @toggle-auto-listen="toggleAutoListen"
        />
        <MiniPlayer
          v-if="music.hasActiveTrack.value"
          :playback="music.playback.value"
          @open="music.openImmersive"
          @toggle-playback="music.togglePlayback"
        />
      </section>
    </Transition>
  </main>
</template>
