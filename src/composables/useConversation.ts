import { computed, ref } from 'vue'
import type { AutoListenState, ConversationResult, ParticleState, UiMessage } from '@/types/app'
import { invokeWithTimeout } from '../utils/invokeWithTimeout'

type UseConversationOptions = {
  delayMs?: number
}

type CancelVoiceInputOptions = {
  silent?: boolean
}

type ChatResponse = {
  intent: ConversationResult['intent']
  music: ConversationResult['music']
  reply: string
  error?: string
}

type ChatAppResult =
  | {
      ok: true
      data: ChatResponse
    }
  | {
      ok: false
      error: {
        code: string
        message: string
      }
    }

const CHAT_BRIDGE_UNAVAILABLE_MESSAGE = '对话通道不可用，请重新启动 Seamo AI R1 后再试。'

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

async function requestAssistantReply(): Promise<ChatResponse> {
  const api = globalThis.window?.lingli

  if (!api) {
    return {
      intent: 'chat',
      music: null,
      reply: '',
      error: CHAT_BRIDGE_UNAVAILABLE_MESSAGE
    }
  }

  try {
    const result = await invokeWithTimeout(
      api.invoke<ChatResponse>('chat.greeting'),
      15000,
      '对话服务响应超时。'
    )

    if (result.ok) {
      return result.data
    }

    return {
      intent: 'chat',
      music: null,
      reply: '',
      error: result.error.message || '问候服务暂时不可用。'
    }
  } catch (error) {
    return {
      intent: 'chat',
      music: null,
      reply: '',
      error: error instanceof Error ? error.message : '对话服务暂时不可用，请稍后再试。'
    }
  }
}

type ChatStreamChunk = { requestId?: string } & (
  | { delta: string }
  | { diagnostic: 'llm_raw_delta' | 'llm_response_start' }
  | {
      done: true
      intent?: ConversationResult['intent']
      music?: ConversationResult['music']
      reply?: string
      error?: { code: string; message: string }
    })

async function streamAssistantReply(
  text: string,
  onDelta: (delta: string) => void,
  options?: {
    onRawChunk?: () => void
    onResponseStart?: () => void
  }
): Promise<ChatResponse> {
  const api = globalThis.window?.lingli

  if (!api) {
    return {
      intent: 'chat',
      music: null,
      reply: '',
      error: CHAT_BRIDGE_UNAVAILABLE_MESSAGE
    }
  }

  return new Promise<ChatResponse>((resolve) => {
    const requestId = globalThis.crypto.randomUUID()
    let resolved = false

    function finish(response: ChatResponse): void {
      if (resolved) {
        return
      }

      resolved = true
      unsubscribe()
      resolve(response)
    }

    const unsubscribe = api.on<ChatStreamChunk>('chat.streamChunk', (chunk) => {
      if (chunk.requestId && chunk.requestId !== requestId) return
      if ('done' in chunk) {
        if (chunk.error) {
          finish({
            intent: 'chat',
            music: null,
            reply: '',
            error: chunk.error.message || '对话服务暂时不可用。'
          })
          return
        }

        finish({
          intent: chunk.intent ?? 'chat',
          music: chunk.music ?? null,
          reply: chunk.reply ?? ''
        })
        return
      }

      if ('diagnostic' in chunk) {
        if (chunk.diagnostic === 'llm_response_start') {
          options?.onResponseStart?.()
        } else if (chunk.diagnostic === 'llm_raw_delta') {
          options?.onRawChunk?.()
        }
        return
      }

      if (chunk.delta) {
        onDelta(chunk.delta)
      }
    })

    api
      .invoke<ChatResponse>('chat.streamMessage', { text, requestId })
      .then((result) => {
        if (!result.ok) {
          finish({
            intent: 'chat',
            music: null,
            reply: '',
            error: result.error.message || '对话服务暂时不可用。'
          })
          return
        }

        finish({
          intent: result.data.intent,
          music: result.data.music,
          reply: result.data.reply
        })
      })
      .catch((error) => {
        finish({
          intent: 'chat',
          music: null,
          reply: '',
          error: error instanceof Error ? error.message : '对话服务暂时不可用，请稍后再试。'
        })
      })
  })
}

export function useConversation(options: UseConversationOptions = {}) {
  const delayMs = options.delayMs ?? 720
  const particleState = ref<ParticleState>('idle')
  const audioLevel = ref(0.12)
  const autoListenState = ref<AutoListenState>('off')
  const isListening = ref(false)
  const messages = ref<UiMessage[]>([])
  let conversationEpoch = 0

  function stopCurrentReply(): void {
    conversationEpoch += 1
    messages.value = messages.value.filter(message => !(message.role === 'assistant' && !message.text))
    particleState.value = 'idle'
    audioLevel.value = 0.14
  }

  function resetConversation(): void {
    conversationEpoch += 1
    messages.value = []
    isListening.value = false
    particleState.value = 'idle'
    audioLevel.value = 0.14
  }

  const latestMessage = computed(() => messages.value[messages.value.length - 1] ?? null)

  function startListening(): void {
    if (isListening.value) {
      return
    }

    isListening.value = true
    if (autoListenState.value === 'armed' || autoListenState.value === 'prehearing' || autoListenState.value === 'grace') {
      autoListenState.value = 'recording'
    }
    particleState.value = 'listening'
    audioLevel.value = 0.42
  }

  function enableAutoListen(): void {
    autoListenState.value = 'armed'
    audioLevel.value = Math.max(audioLevel.value, 0.18)
  }

  function setAutoListenState(state: AutoListenState): void {
    autoListenState.value = state
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

  function markVoiceError(message: string): void {
    isListening.value = false
    particleState.value = 'error'
    audioLevel.value = 0.12
    if (autoListenState.value !== 'off') {
      autoListenState.value = 'error'
    }
    messages.value.push(createMessage('system', message, 'error'))
  }

  function addSystemMessage(message: string): void {
    messages.value.push(createMessage('system', message, 'idle'))
  }

  function cancelVoiceInput(message: string, cancelOptions: CancelVoiceInputOptions = {}): ConversationResult {
    isListening.value = false
    particleState.value = 'idle'
    audioLevel.value = 0.14
    if (
      autoListenState.value === 'prehearing' ||
      autoListenState.value === 'recording' ||
      autoListenState.value === 'grace' ||
      autoListenState.value === 'speech_detected' ||
      autoListenState.value === 'finalizing'
    ) {
      autoListenState.value = 'armed'
    }
    if (!cancelOptions.silent) {
      messages.value.push(createMessage('system', message, 'idle'))
    }

    return {
      intent: 'chat',
      music: null,
      reply: message,
      text: ''
    }
  }

  async function stopListening(
    text: string,
    options?: {
      onChunk?: (delta: string) => void
      onRawChunk?: () => void
      onResponseStart?: () => void
    }
  ): Promise<ConversationResult> {
    if (!text.trim()) return cancelVoiceInput('没有可发送的文字，请重新输入或录音。')
    stopCurrentReply()
    const requestEpoch = conversationEpoch
    if (!isListening.value) {
      startListening()
    }

    isListening.value = false
    const normalizedText = text.trim()

    messages.value.push(createMessage('user', normalizedText, 'listening'))
    if (
      autoListenState.value === 'prehearing' ||
      autoListenState.value === 'recording' ||
      autoListenState.value === 'grace' ||
      autoListenState.value === 'speech_detected'
    ) {
      autoListenState.value = 'finalizing'
    }

    const assistantMessage = createMessage('assistant', '', 'thinking')
    messages.value.push(assistantMessage)
    particleState.value = 'thinking'
    audioLevel.value = 0.24

    const assistant = await streamAssistantReply(
      normalizedText,
      (delta) => {
        if (requestEpoch !== conversationEpoch) return
        assistantMessage.text += delta
        messages.value = [...messages.value]
        options?.onChunk?.(delta)
      },
      {
        onRawChunk: () => { if (requestEpoch === conversationEpoch) options?.onRawChunk?.() },
        onResponseStart: () => { if (requestEpoch === conversationEpoch) options?.onResponseStart?.() }
      }
    )

    if (requestEpoch !== conversationEpoch) {
      return { intent: 'chat', music: null, reply: '', text: normalizedText }
    }

    const replyRole: UiMessage['role'] = assistant.error ? 'system' : 'assistant'
    const nextState: ParticleState = replyRole === 'system' ? 'error' : 'speaking'

    assistantMessage.text = assistant.error || assistant.reply
    assistantMessage.role = replyRole
    assistantMessage.state = nextState
    messages.value = [...messages.value]
    particleState.value = 'idle'
    if (autoListenState.value !== 'off') {
      autoListenState.value = 'armed'
    }
    audioLevel.value = nextState === 'error' ? 0.12 : 0.14

    return {
      intent: assistant.intent,
      music: assistant.music,
      reply: assistant.reply,
      text: normalizedText
    }
  }

  async function generateOpeningGreeting(): Promise<void> {
    if (messages.value.length || isListening.value) return
    const requestEpoch = conversationEpoch
    const assistant = await requestAssistantReply()

    if (requestEpoch !== conversationEpoch) return

    if (assistant.error) {
      messages.value.push(createMessage('system', assistant.error, 'error'))
    } else if (assistant.reply.trim()) {
      messages.value.splice(0, messages.value.length, createMessage('assistant', assistant.reply, 'idle'))
    }
  }

  return {
    audioLevel,
    addSystemMessage,
    autoListenState,
    cancelVoiceInput,
    disableAutoListen,
    enableAutoListen,
    isListening,
    latestMessage,
    markAutoListenError,
    markVoiceError,
    messages,
    particleState,
    generateOpeningGreeting,
    resetConversation,
    stopCurrentReply,
    setAutoListenState,
    startListening,
    stopListening,
    toggleAutoListen
  }
}
