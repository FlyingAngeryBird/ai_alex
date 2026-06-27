<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import ConversationView from '@/components/ConversationView.vue'
import MiniPlayer from '@/components/MiniPlayer.vue'
import MusicImmersiveView from '@/components/MusicImmersiveView.vue'
import ParticleSphere from '@/components/ParticleSphere.vue'
import { useConversation } from '@/composables/useConversation'
import { useMusic } from '@/composables/useMusic'
import type { ParticleState } from '@/types/app'

const conversation = useConversation()
const music = useMusic()
const spaceHeld = ref(false)

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

  return conversation.audioLevel.value
})

async function runMusicDemo(): Promise<void> {
  const result = await conversation.sendMusicDemoRequest()
  if (result.intent === 'play_music') {
    music.startDemoTrack()
  }
}

async function handleKeyUp(event: KeyboardEvent): Promise<void> {
  if (event.code !== 'Space' || !spaceHeld.value) {
    return
  }

  event.preventDefault()
  spaceHeld.value = false

  const result = await conversation.stopListening()
  if (result.intent === 'play_music') {
    music.startDemoTrack()
  }
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.code !== 'Space' || event.repeat || music.viewMode.value !== 'conversation') {
    return
  }

  event.preventDefault()
  spaceHeld.value = true
  conversation.startListening()
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
})
</script>

<template>
  <main class="app-shell" :data-view="music.viewMode.value">
    <ParticleSphere class="particle-stage" :state="particleState" :audio-level="audioLevel" />

    <Transition name="view-fade" mode="out-in">
      <MusicImmersiveView
        v-if="music.viewMode.value === 'music'"
        :playback="music.playback.value"
        @back="music.closeImmersive"
        @toggle-playback="music.togglePlayback"
      />
      <section v-else class="conversation-stage">
        <ConversationView
          :messages="conversation.messages.value"
          :state="conversation.particleState.value"
          :is-listening="conversation.isListening.value"
          @demo-music="runMusicDemo"
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
