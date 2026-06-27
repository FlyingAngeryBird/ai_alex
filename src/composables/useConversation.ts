import { computed, ref } from 'vue'
import type { AutoListenState, ConversationResult, ParticleState, UiMessage } from '@/types/app'

type UseConversationOptions = {
  delayMs?: number
}

const DEFAULT_USER_TEXT = '我想和你聊聊今天的心情'

function wait(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms)
  })
}

function createMessage(role: UiMessage['role'], text: string, state?: ParticleState): UiMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    text,
    state,
    createdAt: Date.now()
  }
}

function detectIntent(text: string): ConversationResult['intent'] {
  return /音乐|歌|播放|music|song/i.test(text) ? 'play_music' : 'chat'
}

function buildAssistantReply(intent: ConversationResult['intent']): string {
  if (intent === 'play_music') {
    return '好，我给你打开一段适合此刻的音乐。'
  }

  return '我在。你刚才说的我记下了，我们可以慢慢往下聊。'
}

export function useConversation(options: UseConversationOptions = {}) {
  const delayMs = options.delayMs ?? 720
  const particleState = ref<ParticleState>('idle')
  const audioLevel = ref(0.12)
  const autoListenState = ref<AutoListenState>('off')
  const isListening = ref(false)
  const messages = ref<UiMessage[]>([
    createMessage('assistant', '晚上好，我在这里。', 'idle')
  ])

  const latestMessage = computed(() => messages.value[messages.value.length - 1] ?? null)

  function startListening(): void {
    if (isListening.value) {
      return
    }

    isListening.value = true
    if (autoListenState.value === 'armed') {
      autoListenState.value = 'speech_detected'
    }
    particleState.value = 'listening'
    audioLevel.value = 0.42
  }

  function enableAutoListen(): void {
    autoListenState.value = 'armed'
    audioLevel.value = Math.max(audioLevel.value, 0.18)
  }

  function disableAutoListen(): void {
    autoListenState.value = 'off'
    if (!isListening.value && particleState.value === 'listening') {
      particleState.value = 'idle'
      audioLevel.value = 0.14
    }
  }

  function markAutoListenError(): void {
    autoListenState.value = 'error'
    if (!isListening.value) {
      particleState.value = 'idle'
      audioLevel.value = 0.14
    }
  }

  function toggleAutoListen(): void {
    if (autoListenState.value === 'off' || autoListenState.value === 'error') {
      enableAutoListen()
      return
    }

    disableAutoListen()
  }

  async function stopListening(text = DEFAULT_USER_TEXT): Promise<ConversationResult> {
    if (!isListening.value) {
      startListening()
    }

    isListening.value = false
    const normalizedText = text.trim() || DEFAULT_USER_TEXT
    const intent = detectIntent(normalizedText)

    messages.value.push(createMessage('user', normalizedText, 'listening'))
    if (autoListenState.value === 'speech_detected') {
      autoListenState.value = 'finalizing'
    }
    particleState.value = 'thinking'
    audioLevel.value = 0.24

    await wait(delayMs)

    messages.value.push(createMessage('assistant', buildAssistantReply(intent), 'speaking'))
    particleState.value = 'speaking'
    if (autoListenState.value !== 'off') {
      autoListenState.value = 'paused_for_tts'
    }
    audioLevel.value = intent === 'play_music' ? 0.56 : 0.38

    await wait(delayMs)

    particleState.value = 'idle'
    if (autoListenState.value === 'paused_for_tts') {
      autoListenState.value = 'armed'
    }
    audioLevel.value = 0.14

    return {
      intent,
      text: normalizedText
    }
  }

  async function sendMusicDemoRequest(): Promise<ConversationResult> {
    startListening()
    return stopListening('放点适合夜晚散步的音乐')
  }

  return {
    audioLevel,
    autoListenState,
    disableAutoListen,
    enableAutoListen,
    isListening,
    latestMessage,
    markAutoListenError,
    messages,
    particleState,
    sendMusicDemoRequest,
    startListening,
    stopListening,
    toggleAutoListen
  }
}
