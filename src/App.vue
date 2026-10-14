<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import MiniPlayer from '@/components/MiniPlayer.vue'
import MusicImmersiveView from '@/components/MusicImmersiveView.vue'
import ParticleSphere from '@/components/ParticleSphere.vue'
import R1SettingsPanel from '@/components/R1SettingsPanel.vue'
import R1MemoryPanel from '@/components/R1MemoryPanel.vue'
import R1TaskPanel from '@/components/R1TaskPanel.vue'
import { useNativeConversation } from '@/composables/useNativeConversation'
import { useTasks } from '@/composables/useTasks'
import R1HistoryPanel from '@/components/R1HistoryPanel.vue'
import R1FocusChip from '@/components/R1FocusChip.vue'
import R1FocusDialog from '@/components/R1FocusDialog.vue'
import { useFocus } from '@/composables/useFocus'
import R1ItemsPanel from '@/components/R1ItemsPanel.vue'
import SearchPanel from '@/components/SearchPanel.vue'
import R1CompanionHome from '@/components/R1CompanionHome.vue'
import R1Composer from '@/components/R1Composer.vue'
import { AudioLines, Brain, Headphones, History, MessageCircle, Mic, MicOff, NotebookPen,
  Settings2 } from 'lucide-vue-next'
import { useAutoListen } from '@/composables/useAutoListen'
import { useConversation } from '@/composables/useConversation'
import { useKeyboardRecorder } from '@/composables/useKeyboardRecorder'
import { useMusic } from '@/composables/useMusic'
import { useRealtimeVoiceRecorder } from '@/composables/useRealtimeVoiceRecorder'
import { createAutoListenSession } from '@/services/autoListenSession'
import { evaluateAutoListenTranscript } from '@/services/autoListenTranscriptGate'
import { createPushToTalkController, type PushToTalkSource } from '@/services/pushToTalkController'
import type { VoiceActivityDiagnostics } from '@/services/voiceActivity'
import type { AutoListenState, ParticleState, VoiceInputMode, VoiceLatencyTrace } from '@/types/app'
import type { R1Persona } from '../electron/main/r1/persona'
import type { CredentialStatus } from '../electron/main/r1/credentials'
import { invokeWithTimeout } from './utils/invokeWithTimeout'

const conversation = useConversation()
const keyboardRecorder = useKeyboardRecorder()
const music = useMusic()
const focusNotice = ref('')
const focus = useFocus(event => {
  const track = music.playback.value.track
  const currentTrackKey = track ? `${track.source ?? 'unknown'}:${track.id}` : null
  if (event.focus.endMusicRule === 'pause_user_selected_track' &&
    event.focus.endTargetTrackKey === currentTrackKey && music.playback.value.status === 'playing') {
    void music.togglePlayback()
  }
  focusNotice.value = '这一段专注已完成，可以休息一下。'
})
const focusEditorOpen = ref(false)
const focusTargetTrack = ref<{ key: string; title: string } | null>(null)
function openFocusEditor(): void {
  focusEditorOpen.value = true
  const track = music.playback.value.track
  focusTargetTrack.value = track ? { key: `${track.source ?? 'unknown'}:${track.id}`, title: track.title } : null
  focus.error.value = ''
}
async function startFocus(durationSec: number, target: string | null): Promise<void> {
  if (await focus.start(durationSec, target)) {
    focusEditorOpen.value = false
    focusNotice.value = ''
  }
}
const conversationPartialText = ref('')
const realtimeRecorder = useRealtimeVoiceRecorder({
  onPartialText: (text) => {
    conversationPartialText.value = text
  }
})
const assistantAudioLevel = ref(0.14)
const assistantAudioPlaying = ref(false)
const nativeConversation = useNativeConversation({
  onSpeaking(value) { assistantAudioPlaying.value = value },
  onError(message) { conversation.disableAutoListen(); conversation.particleState.value = 'idle'; conversationPartialText.value = ''; conversation.addSystemMessage(message) },
  onText(event) {
    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      conversationPartialText.value += typeof event.delta === 'string' ? event.delta : ''
    } else if (event.type === 'conversation.item.input_audio_transcription.started') {
      conversationPartialText.value = ''
      conversation.particleState.value = 'listening'
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      conversationPartialText.value = ''
      if (typeof event.transcript === 'string' && event.transcript.trim()) {
        conversation.messages.value.push({ id: String(event.item_id), role: 'user', text: event.transcript, createdAt: Date.now() })
      }
      conversation.particleState.value = 'thinking'
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done') {
      const id = String(event.response_id)
      let message = conversation.messages.value.find(item => item.id === id)
      if (!message) { conversation.messages.value.push({ id, role: 'assistant', text: '', createdAt: Date.now() }); message = conversation.messages.value.at(-1)! }
      if (event.type.endsWith('.delta') && typeof event.delta === 'string') message.text += event.delta
      else if (typeof event.text === 'string') message.text = event.text
    } else if (event.type === 'response.done' || event.type === 'response.canceled') {
      conversation.particleState.value = 'idle'
    }
  }
})
watch([assistantAudioPlaying, nativeConversation.userSpeaking], ([assistant, user]) => {
  music.setSpeechActive(assistant || user)
})
let currentVoiceTrace: VoiceLatencyTrace | null = null

function startVoiceTrace(): void {
  currentVoiceTrace = { space_up: performance.now() }
}

function markVoiceTrace(point: string): void {
  if (!currentVoiceTrace) {
    return
  }
  (currentVoiceTrace as Record<string, number>)[point] = performance.now()
}

function getLastLatencyTrace(): VoiceLatencyTrace | null {
  return currentVoiceTrace ? { ...currentVoiceTrace } : null
}

const autoListenSession = createAutoListenSession()
const panelCollapsed = ref(false)
const spaceHeld = ref(false)
const settingsOpen = ref(false)
const itemsOpen = ref(false)
const taskState = useTasks(window.seamoR1.tasks)
const taskOpen = ref(false)
function openTask(): void {
  closePanels()
  if (!taskState.selected.value) taskState.selectedId.value = taskState.tasks.value.at(-1)?.taskId ?? null
  taskOpen.value = true
}
const searchOpen = ref(false)
const searchEverOpened = ref(false)
const memoryOpen = ref(false)
const historyOpen = ref(false)
const textBusy = ref(false)
const composer = ref<InstanceType<typeof R1Composer> | null>(null)
const credentialStatus = ref<CredentialStatus | null>(null)
const persona = ref<R1Persona | null>(null)
const currentDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
const hasSidePanel = computed(() => settingsOpen.value || itemsOpen.value || memoryOpen.value || historyOpen.value)
const serviceLabel = computed(() => credentialStatus.value?.VOLCENGINE_ARK_API_KEY &&
  credentialStatus.value?.VOLCENGINE_ARK_MODEL ? '对话服务已配置 · 实际连接以请求结果为准' : '对话服务未配置')

function openPanel(panel: 'settings' | 'items' | 'search' | 'memory' | 'history'): void {
  taskOpen.value = false
  settingsOpen.value = panel === 'settings'
  itemsOpen.value = panel === 'items'
  searchOpen.value = panel === 'search'
  memoryOpen.value = panel === 'memory'
  historyOpen.value = panel === 'history'
  if (panel === 'search') searchEverOpened.value = true
}

function closePanels(): void {
  taskOpen.value = false
  settingsOpen.value = false
  itemsOpen.value = false
  searchOpen.value = false
  memoryOpen.value = false
  historyOpen.value = false
}
const temporaryMode = ref(false)
const reminderNotice = ref<{ body: string; dueAtUtc: string; systemRequested: boolean } | null>(null)
let stopReminderNotice: (() => void) | null = null
let stopMemoryInvalidation: (() => void) | null = null
const voicePreviewing = ref(false)
let currentAssistantAudio: HTMLAudioElement | null = null
let currentAssistantAudioTimer: number | null = null
let currentAssistantAudioUrl: string | null = null
let startupGreetingTimer: number | null = null
let autoListenGraceTimer: number | null = null
let autoListenRecoveryTimer: number | null = null
let autoListenRecoveryUntilMs: number | null = null
let activeVoiceInputMode: VoiceInputMode | null = null
let voiceCaptureStartedAt: number | null = null
let voiceFinishPromise: Promise<void> | null = null
let voiceStartPromise: Promise<boolean> | null = null
let voiceCancelPromise: Promise<void> | null = null
let autoListenModeGeneration = 0
const pushToTalk = createPushToTalkController({
  canStart: () => !voiceStartPromise && !voiceFinishPromise && !voiceCancelPromise && !textBusy.value &&
    conversation.particleState.value !== 'thinking',
  onHeldChange: held => { spaceHeld.value = held },
  onError: error => conversation.markVoiceError(getVoiceErrorMessage(error)),
  start: async () => {
    clearAutoListenRecoveryTimer()
    clearAutoListenGraceTimer()
    if (activeVoiceInputMode === 'auto_listen') {
      await cancelActiveVoiceCapture()
    }
    voiceStartPromise = startVoiceCapture()
    try { return await voiceStartPromise } finally { voiceStartPromise = null }
  },
  finish: finishActiveVoiceCapture,
  cancel: async () => {
    await cancelActiveVoiceCapture()
    conversation.cancelVoiceInput('本次录音已取消，没有发送。')
    recoverAutoListenAfterVoiceCancel()
  }
})
const viewMode = computed(() => music.viewMode.value)
const autoLevelStates = new Set<AutoListenState>(['armed', 'prehearing', 'recording', 'grace'])
const AUTO_LISTEN_REJECTION_COOLDOWN_MS = 760

type MicrophoneAccessResult = {
  granted: boolean
  status: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'
}

type AutoListenDebugBridge = {
  getAutoListenBlockers: () => ReturnType<typeof getAutoListenBlockers>
  getAutoListenDiagnostics: () => VoiceActivityDiagnostics
  getAutoListenRecoveryMs: () => number
  getAutoListenState: () => AutoListenState
  getLastLatencyTrace: () => VoiceLatencyTrace | null
}

type DebugWindow = Window & {
  __lingmoDebug?: AutoListenDebugBridge
}

function getAutoListenBlockers() {
  const viewMode = music.viewMode.value

  return {
    assistantSpeaking: assistantAudioPlaying.value,
    manualVoiceActive: pushToTalk.isBusy() || Boolean(voiceCancelPromise),
    musicActive: viewMode === 'music'
  }
}

function getAutoListenRecoveryMs(): number {
  if (autoListenRecoveryUntilMs === null) {
    return 0
  }

  return Math.max(0, autoListenRecoveryUntilMs - performance.now())
}

const autoListen = useAutoListen({
  canDetect: () =>
    music.viewMode.value === 'conversation' &&
    autoListenSession.canDetect(getAutoListenBlockers()),
  onSpeechStart: async () => {
    if (music.viewMode.value !== 'conversation') {
      return
    }

    const nextState = autoListenSession.speechStart()

    if (nextState === 'recording') {
      clearAutoListenGraceTimer()
      conversation.setAutoListenState('recording')
      return
    }

    if (nextState !== 'prehearing' || voiceStartPromise) {
      return
    }

    conversation.setAutoListenState('prehearing')
    const generation = autoListenModeGeneration
    voiceStartPromise = startVoiceCapture()
    const didStart = await voiceStartPromise
    if (generation !== autoListenModeGeneration || !autoListen.enabled.value) {
      await cancelActiveVoiceCapture()
      voiceStartPromise = null
      conversation.cancelVoiceInput('', { silent: true })
      if (autoListen.enabled.value) {
        autoListenSession.ready()
        conversation.setAutoListenState('armed')
      }
      return
    }
    voiceStartPromise = null

    if (!didStart) {
      autoListenSession.fail()
      return
    }

    autoListenSession.recording()
    conversation.setAutoListenState('recording')
  },
  onSpeechEnd: async () => {
    if (!conversation.isListening.value || music.viewMode.value !== 'conversation') {
      return
    }

    const nextState = autoListenSession.speechEnd()

    if (nextState === 'grace') {
      conversation.setAutoListenState('grace')
      scheduleAutoListenGraceFinish()
    }
  }
})

function installDebugBridge(): void {
  const debugWindow = window as DebugWindow

  debugWindow.__lingmoDebug = {
    getAutoListenBlockers,
    getAutoListenDiagnostics: () => autoListen.diagnostics.value,
    getAutoListenRecoveryMs,
    getAutoListenState: () => conversation.autoListenState.value,
    getLastLatencyTrace
  }
}

function uninstallDebugBridge(): void {
  const debugWindow = window as DebugWindow

  delete debugWindow.__lingmoDebug
}

const particleState = computed<ParticleState>(() => {
  if (assistantAudioPlaying.value && music.viewMode.value === 'conversation') {
    return 'speaking'
  }

  if (music.viewMode.value === 'music' && music.playback.value.status !== 'error') {
    return music.playback.value.status === 'paused' ? 'idle' : 'playing'
  }

  if (music.playback.value.status === 'playing' && conversation.particleState.value === 'idle') {
    return 'playing'
  }

  return conversation.particleState.value
})

const conversationPanelState = computed<ParticleState>(() => {
  return assistantAudioPlaying.value ? 'speaking' : conversation.particleState.value
})

const audioLevel = computed(() => {
  if (assistantAudioPlaying.value) {
    return assistantAudioLevel.value
  }

  if (particleState.value === 'playing') {
    return music.audioLevel.value
  }

  if (autoListen.enabled.value && autoLevelStates.has(conversation.autoListenState.value)) {
    return Math.max(conversation.audioLevel.value, Math.min(0.48, autoListen.level.value * 2.4))
  }

  return conversation.audioLevel.value
})

function requestMusicPlayback(): void {
  music.openImmersive()
}

async function exitMusicPlayback(): Promise<void> {
  await music.exitPlayback()
}

function clearAutoListenGraceTimer(): void {
  if (autoListenGraceTimer !== null) {
    window.clearTimeout(autoListenGraceTimer)
    autoListenGraceTimer = null
  }
}

function clearAutoListenRecoveryTimer(): void {
  if (autoListenRecoveryTimer !== null) {
    window.clearTimeout(autoListenRecoveryTimer)
    autoListenRecoveryTimer = null
  }
  autoListenRecoveryUntilMs = null
}

function resumeAutoListenAfterAssistantAudio(): void {
  if (!autoListen.enabled.value || music.viewMode.value !== 'conversation') {
    return
  }

  autoListenSession.ready()
  conversation.setAutoListenState('armed')
}

function pauseAutoListenForAssistant(): void {
  if (!autoListen.enabled.value || conversation.autoListenState.value === 'off') {
    return
  }

  clearAutoListenRecoveryTimer()
  autoListenSession.pauseForAssistant()
  conversation.setAutoListenState('paused_for_tts')
}

function recoverAutoListenAfterVoiceCancel(): void {
  clearAutoListenRecoveryTimer()

  if (!autoListen.enabled.value || conversation.autoListenState.value === 'off') {
    return
  }

  autoListenSession.ready()
  conversation.setAutoListenState('armed')
}

function scheduleAutoListenRecovery(): void {
  clearAutoListenRecoveryTimer()

  if (!autoListen.enabled.value || conversation.autoListenState.value === 'off') {
    return
  }

  autoListenSession.pauseForAssistant()
  conversation.setAutoListenState('paused_for_tts')
  autoListenRecoveryUntilMs = performance.now() + AUTO_LISTEN_REJECTION_COOLDOWN_MS
  autoListenRecoveryTimer = window.setTimeout(() => {
    autoListenRecoveryTimer = null
    autoListenRecoveryUntilMs = null
    recoverAutoListenAfterVoiceCancel()
  }, AUTO_LISTEN_REJECTION_COOLDOWN_MS)
}

function scheduleAutoListenGraceFinish(): void {
  clearAutoListenGraceTimer()
  autoListenGraceTimer = window.setTimeout(() => {
    const nextState = autoListenSession.graceExpired()

    if (nextState !== 'finalizing') {
      return
    }

    conversation.setAutoListenState('finalizing')
    void finishActiveVoiceCapture()
  }, 1120)
}

function stopCurrentResponse(): void {
  if (nativeConversation.active.value) void nativeConversation.interrupt()
  conversation.stopCurrentReply()
  void window.lingli.invoke('chat.stopResponse')
  releaseAssistantAudio(true)
}

function releaseAssistantAudio(resumeAutoListen = false): void {
  assistantAudioPlaying.value = false
  assistantAudioLevel.value = 0.14
  if (currentAssistantAudioTimer !== null) {
    window.clearInterval(currentAssistantAudioTimer)
    currentAssistantAudioTimer = null
  }

  if (currentAssistantAudio) {
    currentAssistantAudio.pause()
    currentAssistantAudio = null
  }

  if (currentAssistantAudioUrl) {
    URL.revokeObjectURL(currentAssistantAudioUrl)
    currentAssistantAudioUrl = null
  }

  if (resumeAutoListen) {
    resumeAutoListenAfterAssistantAudio()
  }
}

async function speakAssistantReply(text?: string, voiceOverride?: string): Promise<void> {
  const content = text?.trim()
  const api = window.lingli

  if (!content || !api) {
    resumeAutoListenAfterAssistantAudio()
    return
  }

  const voiceId = voiceOverride?.trim() || persona.value?.voiceId.trim() || ''

  try {
    markVoiceTrace('tts_first_push')
    const result = await invokeWithTimeout(
      api.invoke<{ audio: ArrayBuffer; mimeType: string }>('tts.speak', {
        text: content,
        ...(voiceId ? { voice: voiceId } : {})
      }),
      15000,
      '语音合成响应超时。'
    )

    if (!result.ok) {
      resumeAutoListenAfterAssistantAudio()
      return
    }

    markVoiceTrace('tts_first_audio')
    releaseAssistantAudio()
    const blob = new Blob([result.data.audio], { type: result.data.mimeType })
    currentAssistantAudioUrl = URL.createObjectURL(blob)
    currentAssistantAudio = new Audio(currentAssistantAudioUrl)
    currentAssistantAudio.addEventListener('playing', () => {
      markVoiceTrace('tts_play_start')
    }, { once: true })
    currentAssistantAudio.addEventListener('ended', () => {
      markVoiceTrace('tts_play_end')
      releaseAssistantAudio(true)
    }, { once: true })
    assistantAudioPlaying.value = true
    currentAssistantAudioTimer = window.setInterval(() => {
      const time = currentAssistantAudio?.currentTime ?? 0
      assistantAudioLevel.value = 0.3 + Math.abs(Math.sin(time * 9.5)) * 0.3
    }, 80)
    markVoiceTrace('tts_play_invoked')
    await currentAssistantAudio.play()
  } catch {
    releaseAssistantAudio(true)
  }
}

function getVoiceErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''

  if (/denied|permission|not.?allowed|权限|授权|麦克风/i.test(message)) {
    return '我还没有拿到麦克风权限。请在 macOS「系统设置 > 隐私与安全性 > 麦克风」里允许 Seamo AI R1 使用麦克风。'
  }

  if (message) {
    return `语音输入没有启动成功：${message}`
  }

  return '语音输入没有启动成功，请稍后再试一次。'
}

function shouldFallbackToOneShotRecording(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''

  return /AudioContext|音频上下文|ScriptProcessor|当前环境无法创建/i.test(message)
}

async function ensureMicrophoneAccess(): Promise<void> {
  const api = window.lingli

  if (!api) {
    throw new Error('语音通道不可用，请确认从 Seamo AI R1 桌面应用启动。')
  }

  const result = await invokeWithTimeout(
    api.invoke<MicrophoneAccessResult>('app.requestMicrophoneAccess'),
    6000,
    '麦克风权限请求超时。'
  )

  if (!result.ok) {
    throw new Error(result.error.message)
  }

  if (!result.data.granted) {
    throw new Error(`麦克风权限未开启（${result.data.status}）`)
  }
}

async function startVoiceCapture(): Promise<boolean> {
  releaseAssistantAudio()
  conversation.startListening()

  try {
    await ensureMicrophoneAccess()
  } catch (error) {
    conversation.markVoiceError(getVoiceErrorMessage(error))
    return false
  }

  let realtimeStartError: unknown

  const manualCapture = pushToTalk.isBusy()
  activeVoiceInputMode = manualCapture ? 'push_to_talk' : 'auto_listen'
  voiceCaptureStartedAt = performance.now()

  try {
    const autoListenStream = autoListen.enabled.value && !manualCapture
      ? autoListen.getMediaStream() ?? undefined
      : undefined
    const initialAudio = autoListen.enabled.value && !manualCapture
      ? autoListen.consumeBufferedAudio()
      : undefined

    await realtimeRecorder.start({ initialAudio, stream: autoListenStream })
    return true
  } catch (error) {
    realtimeStartError = error
    if (!shouldFallbackToOneShotRecording(error)) {
      conversation.markVoiceError(
        getVoiceErrorMessage(realtimeRecorder.errorMessage.value || realtimeStartError)
      )
      activeVoiceInputMode = null
      voiceCaptureStartedAt = null
      return false
    }

    try {
      await keyboardRecorder.start()
      return true
    } catch (fallbackError) {
      conversation.markVoiceError(
        getVoiceErrorMessage(
          keyboardRecorder.errorMessage.value ||
            realtimeRecorder.errorMessage.value ||
            fallbackError ||
            realtimeStartError
        )
      )
      activeVoiceInputMode = null
      voiceCaptureStartedAt = null
      return false
    }
  }
}

async function finishVoiceCapture(): Promise<void> {
  startVoiceTrace()
  let text = ''
  const shouldGateAutoTranscript = activeVoiceInputMode === 'auto_listen'
  const captureDurationMs = voiceCaptureStartedAt === null
    ? undefined
    : Math.max(0, performance.now() - voiceCaptureStartedAt)
  activeVoiceInputMode = null
  voiceCaptureStartedAt = null

  clearAutoListenGraceTimer()

  if (!realtimeRecorder.isRecording.value && !keyboardRecorder.isRecording.value) {
    conversation.cancelVoiceInput('刚刚没有开始录音，请再按住 Space 试一次。')
    recoverAutoListenAfterVoiceCancel()
    return
  }

  if (realtimeRecorder.isRecording.value) {
    try {
      const transcription = await realtimeRecorder.stopAndTranscribe()
      text = transcription.text
    } catch (error) {
      conversation.cancelVoiceInput(getVoiceErrorMessage(error))
      recoverAutoListenAfterVoiceCancel()
      return
    }
  } else if (keyboardRecorder.isRecording.value) {
    try {
      const transcription = await keyboardRecorder.stopAndTranscribe()
      text = transcription.text
    } catch (error) {
      conversation.cancelVoiceInput(getVoiceErrorMessage(error))
      recoverAutoListenAfterVoiceCancel()
      return
    }
  }

  markVoiceTrace('asr_final')

  if (!text.trim()) {
    conversation.cancelVoiceInput('刚刚没有识别到声音，请再按住 Space 说一遍。', {
      silent: shouldGateAutoTranscript
    })
    shouldGateAutoTranscript ? scheduleAutoListenRecovery() : recoverAutoListenAfterVoiceCancel()
    return
  }

  if (shouldGateAutoTranscript) {
    const transcriptDecision = evaluateAutoListenTranscript(text, {
      durationMs: captureDurationMs
    })

    if (!transcriptDecision.accepted) {
      conversation.cancelVoiceInput(transcriptDecision.message, { silent: true })
      scheduleAutoListenRecovery()
      return
    }

    text = transcriptDecision.text
  }

  markVoiceTrace('llm_request_start')
  let llmFirstDeltaMarked = false
  let llmFirstRawDeltaMarked = false

  const result = await conversation.stopListening(text, {
    onChunk: (delta) => {
      if (!llmFirstDeltaMarked) {
        llmFirstDeltaMarked = true
        markVoiceTrace('llm_first_delta')
      }
    },
    onRawChunk: () => {
      if (!llmFirstRawDeltaMarked) {
        llmFirstRawDeltaMarked = true
        markVoiceTrace('llm_first_raw_delta')
      }
    },
    onResponseStart: () => {
      markVoiceTrace('llm_response_start')
    }
  })
  markVoiceTrace('llm_done')

  pauseAutoListenForAssistant()
  await speakAssistantReply(result.reply)

  if (result.intent === 'play_music') {
    const playback = await music.playRequest(result.music?.keyword ?? result.text)
    if (playback.status === 'error' && playback.errorMessage) {
      conversation.addSystemMessage(playback.errorMessage)
    }
  }
}

async function finishActiveVoiceCapture(): Promise<void> {
  if (voiceFinishPromise) {
    return voiceFinishPromise
  }

  voiceFinishPromise = finishVoiceCapture().finally(() => {
    voiceFinishPromise = null
  })

  return voiceFinishPromise
}

async function toggleAutoListen(): Promise<void> {
  if (nativeConversation.active.value || nativeConversation.starting.value) {
    await nativeConversation.stop()
    conversation.disableAutoListen()
    conversation.particleState.value = 'idle'
    conversationPartialText.value = ''
    return
  }
  ++autoListenModeGeneration
  await pushToTalk.cancel()
  await pushToTalk.whenIdle()
  autoListen.stop()
  clearAutoListenGraceTimer()
  clearAutoListenRecoveryTimer()
  releaseAssistantAudio()
  conversation.stopCurrentReply()
  await window.lingli.invoke('chat.stopResponse')
  conversation.setAutoListenState('arming')
  if (await nativeConversation.start()) conversation.setAutoListenState('armed')
  else conversation.disableAutoListen()
}

async function cancelActiveVoiceCapture(): Promise<void> {
  if (voiceCancelPromise) return voiceCancelPromise
  voiceCancelPromise = (async () => {
    keyboardRecorder.cancel()
    await realtimeRecorder.cancel()
    activeVoiceInputMode = null
    voiceCaptureStartedAt = null
  })().finally(() => { voiceCancelPromise = null })
  return voiceCancelPromise
}

async function handleKeyUp(event: KeyboardEvent): Promise<void> {
  if (event.code !== 'Space' || pushToTalk.owner() !== 'keyboard') {
    return
  }

  event.preventDefault()
  await endPushToTalk('keyboard')
}

async function handleKeyDown(event: KeyboardEvent): Promise<void> {
  const target = event.target
  if (target instanceof HTMLElement && (target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return
  if (target instanceof HTMLElement && target.closest('button') &&
    !target.closest('.r1-microphone')) return
  if (
    event.code !== 'Space' ||
    event.repeat ||
    spaceHeld.value ||
    voiceStartPromise
  ) {
    return
  }

  event.preventDefault()
  await beginPushToTalk('keyboard')
}

async function beginPushToTalk(source: PushToTalkSource = 'button'): Promise<void> {
  if (nativeConversation.active.value || nativeConversation.starting.value) {
    await nativeConversation.stop(); conversation.disableAutoListen(); conversation.stopCurrentReply()
  }
  await pushToTalk.press(source)
}
async function endPushToTalk(source: PushToTalkSource = 'button'): Promise<void> { await pushToTalk.release(source) }
function cancelPushToTalk(): void { void pushToTalk.cancel() }
function handleWindowBlur(): void { cancelPushToTalk() }
function handleVisibilityChange(): void { if (document.hidden) cancelPushToTalk() }

async function handleSendText(text: string, complete?: (accepted: boolean) => void): Promise<void> {
  if (textBusy.value || conversation.isListening.value ||
    conversation.particleState.value === 'thinking') {
    complete?.(false)
    return
  }
  textBusy.value = true
  await nativeConversation.stop()
  conversation.disableAutoListen()
  releaseAssistantAudio()
  try {
    const response = await conversation.stopListening(text)
    complete?.(Boolean(response.reply))
    pauseAutoListenForAssistant()
    await speakAssistantReply(response.reply)
    if (response.intent === 'play_music') {
      const playback = await music.playRequest(response.music?.keyword ?? response.text)
      if (playback.status === 'error' && playback.errorMessage) conversation.addSystemMessage(playback.errorMessage)
    }
  } catch (error) {
    complete?.(false)
    conversation.addSystemMessage(error instanceof Error ? error.message : '消息没有发送成功，请重试。')
  } finally { textBusy.value = false }
}

async function handleToggleTemporary(): Promise<void> {
  if (conversation.isListening.value || assistantAudioPlaying.value ||
    conversation.particleState.value === 'thinking') {
    conversation.addSystemMessage('请先结束当前语音或等待回答结束，再切换临时对话。')
    return
  }
  await nativeConversation.stop()
  conversation.disableAutoListen()
  const next = !temporaryMode.value
  const result = await window.lingli.invoke<{ temporary: boolean }>('chat.setTemporary', { enabled: next })
  if (!result.ok) {
    conversation.addSystemMessage(result.error.message)
    return
  }
  if (startupGreetingTimer !== null) {
    window.clearTimeout(startupGreetingTimer)
    startupGreetingTimer = null
  }
  releaseAssistantAudio()
  conversation.resetConversation()
  temporaryMode.value = result.data.temporary
  taskState.changeScope()
  taskOpen.value = false
  conversation.addSystemMessage(temporaryMode.value
    ? '已进入临时对话。这里的聊天不会保存，也不会读取长期记忆。'
    : '已退出临时对话。刚才的临时聊天已清除。')
}

async function handlePreviewVoice(voiceId: string): Promise<void> {
  await nativeConversation.stop()
  conversation.disableAutoListen()
  voicePreviewing.value = true

  try {
    await speakAssistantReply('你好，这是当前的音色试听。', voiceId)
  } finally {
    voicePreviewing.value = false
  }
}

onMounted(() => {
  taskState.start()
  void Promise.all([window.seamoR1.credentials.status(), window.seamoR1.persona.get()]).then(([credentials, currentPersona]) => {
    if (credentials.ok) credentialStatus.value = credentials.data
    if (currentPersona.ok) persona.value = currentPersona.data
    else conversation.addSystemMessage('人格设置暂时无法读取，请重新启动应用。')
    if (!credentials.ok || !currentPersona.ok ||
      !credentials.data.VOLCENGINE_ARK_API_KEY || !credentials.data.VOLCENGINE_ARK_MODEL) return
    startupGreetingTimer = window.setTimeout(() => {
      if (conversation.messages.value.length || conversation.isListening.value || nativeConversation.active.value || nativeConversation.starting.value) return
      void conversation.generateOpeningGreeting().then(() => {
        const greeting = conversation.messages.value[0]
        if (greeting?.role === 'assistant' && conversation.messages.value.length === 1) {
          void speakAssistantReply(greeting.text)
        }
      })
    }, 900)
  })
  stopReminderNotice = window.seamoR1?.reminders.onDue((event) => {
    reminderNotice.value = event
  }) ?? null
  stopMemoryInvalidation = window.seamoR1.memory.onInvalidated(() => {
    if (assistantAudioPlaying.value || conversation.particleState.value === 'thinking') {
      releaseAssistantAudio(true)
      conversation.addSystemMessage('记忆已更新，已停止旧上下文的回复。')
    }
  })
  installDebugBridge()
  void music.loadLibrary()
  window.addEventListener('keydown', handleKeyDown)
  window.addEventListener('keyup', handleKeyUp)
  window.addEventListener('blur', handleWindowBlur)
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

onBeforeUnmount(() => {
  void nativeConversation.stop()
  taskState.dispose()
  void pushToTalk.dispose()
  window.removeEventListener('blur', handleWindowBlur)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  stopMemoryInvalidation?.()
  stopReminderNotice?.()
  uninstallDebugBridge()
  window.removeEventListener('keydown', handleKeyDown)
  window.removeEventListener('keyup', handleKeyUp)
  clearAutoListenGraceTimer()
  clearAutoListenRecoveryTimer()
  if (startupGreetingTimer !== null) {
    window.clearTimeout(startupGreetingTimer)
    startupGreetingTimer = null
  }
  autoListen.stop()
  releaseAssistantAudio()
})
</script>

<template>
  <main class="r1-shell" :data-view="viewMode" :class="{ 'r1-has-side-panel': hasSidePanel, 'r1-has-wide-panel': searchOpen || taskOpen }">
    <header class="r1-app-header">
      <button class="r1-brand" type="button" @click="music.closeImmersive(); closePanels()"
        aria-label="返回 Seamo 陪伴首页"><AudioLines :size="25" /><span>Seamo <em>AI</em></span></button>
      <time>{{ currentDate }}</time>
      <div class="r1-header-right"><button v-if="taskState.tasks.value.length && !taskOpen" type="button" class="r1-header-task" @click="openTask">查看委托</button><span class="r1-mic-state"><Mic v-if="(conversation.isListening.value || nativeConversation.active.value)" :size="14" /><MicOff v-else :size="14" />{{ conversation.isListening.value || nativeConversation.active.value ? '正在收音' : '麦克风未开启' }}</span></div>
    </header>
    <nav class="r1-rail" aria-label="主导航">
      <button type="button" :aria-current="viewMode === 'conversation' && !hasSidePanel && !searchOpen ? 'page' : undefined"
        aria-label="陪伴" @click="music.closeImmersive(); closePanels()"><MessageCircle :size="20" /><span>陪伴</span></button>
      <button type="button" :aria-current="viewMode === 'music' ? 'page' : undefined"
        aria-label="音乐" @click="music.openImmersive(); closePanels()"><Headphones :size="20" /><span>音乐</span></button>
      <i class="r1-rail-divider" />
      <button type="button" :aria-current="memoryOpen ? 'page' : undefined" aria-label="记忆"
        @click="openPanel('memory')"><Brain :size="20" /><span>记忆</span></button>
      <button type="button" :aria-current="itemsOpen ? 'page' : undefined" aria-label="事项"
        @click="openPanel('items')"><NotebookPen :size="20" /><span>事项</span></button>
      <div class="r1-rail-bottom">
        <button type="button" :aria-current="historyOpen ? 'page' : undefined" aria-label="历史对话"
          @click="openPanel('history')"><History :size="20" /><span>历史</span></button>
        <button type="button" :aria-current="settingsOpen ? 'page' : undefined" aria-label="设置"
          @click="openPanel('settings')"><Settings2 :size="20" /><span>设置</span></button>
      </div>
    </nav>
    <section class="r1-main-space" aria-label="Seamo 陪伴空间">
      <R1FocusChip v-if="focus.active.value && focus.state.value" :focus="focus.state.value" :busy="focus.busy.value"
        @pause="focus.control('pause')" @resume="focus.control('resume')" @stop="focus.control('stop')" />
      <div class="r1-particle-space" :data-mode="viewMode">
        <ParticleSphere :state="particleState" :audio-level="audioLevel" :audio-bands="music.audioBands.value" />
      </div>
      <MiniPlayer v-if="viewMode === 'conversation' && music.hasActiveTrack.value"
        class="r1-ambient-player" :playback="music.playback.value"
        @open="music.openImmersive" @toggle-playback="music.togglePlayback" />
      <Transition name="view-fade" mode="out-in">
      <MusicImmersiveView
        v-if="viewMode === 'music'"
        :active-tab="music.activeTab.value"
        :volume="music.volume.value" :assistant-speaking="assistantAudioPlaying" @volume-change="music.setVolume"
        :favorites="music.favorites.value"
        :playback="music.playback.value"
        :search-history="music.searchHistory.value"
        :search-query="music.searchQuery.value"
        :search-results="music.searchResults.value"
        :search-results-visible="music.searchResultsVisible.value"
        :source-preference="music.sourcePreference.value"
        @back="music.closeImmersive"
        @change-tab="music.setActiveTab"
        @exit="exitMusicPlayback"
        @next-track="music.nextTrack"
        @play-all-favorites="music.playAllFavorites"
        @previous-track="music.previousTrack"
        @remove-history="music.removeSearchHistory"
        @search="music.searchMusic"
        @select-favorite="music.playFavorite"
        @select-history="music.searchMusic"
        @select-search-result="music.playSearchResult"
        @source-change="(sourcePreference) => { music.sourcePreference.value = sourcePreference }"
        @toggle-favorite="music.toggleFavorite"
        @toggle-playback="music.togglePlayback"
      />
      <R1CompanionHome
          v-else
          :assistant-name="persona?.assistantName || 'Seamo AI'"
          :messages="conversation.messages.value"
          :state="conversationPanelState"
          :partial-text="conversationPartialText"
          :temporary-mode="temporaryMode"
          @open-history="openPanel('history')"
          @open-search="openPanel('search')"
          @start-chat="composer?.focusInput()"
        />
    </Transition>
      <R1Composer ref="composer" :auto-listen-state="conversation.autoListenState.value"
        :assistant-name="persona?.assistantName || 'Seamo AI'"
        :busy="textBusy || conversation.isListening.value || conversation.particleState.value === 'thinking' || assistantAudioPlaying"
        :is-listening="conversation.isListening.value" :temporary-mode="temporaryMode"
        :service-label="serviceLabel" :music-active="viewMode === 'music'"
        @send="handleSendText" @voice-press-start="beginPushToTalk()" @voice-press-end="endPushToTalk()" @voice-press-cancel="cancelPushToTalk"
        @toggle-temporary="handleToggleTemporary" @toggle-auto-listen="toggleAutoListen"
        @stop-speech="stopCurrentResponse" />
    </section>

    <R1TaskPanel v-show="taskOpen" :tasks="taskState.tasks.value" :selected="taskState.selected.value"
      :busy="taskState.busy.value" :loading="taskState.loading.value" :error="taskState.error.value"
      @close="closePanels" @select="(id) => { taskState.selectedId.value = id }"
      @control="taskState.control" @retry="taskState.refresh" />
    <R1SettingsPanel
      v-if="settingsOpen"
      :persona="persona"
      :voice-previewing="voicePreviewing"
      @close="closePanels"
      @preview-voice="handlePreviewVoice"
      @saved="(saved) => { persona = saved }"
      @credentials-changed="(status) => { credentialStatus = status }"
    />
    <R1ItemsPanel v-if="itemsOpen" :temporary-mode="temporaryMode" @close="closePanels" @start-focus="openFocusEditor" />
    <SearchPanel v-if="searchEverOpened" v-show="searchOpen" :temporary-mode="temporaryMode" @close="closePanels" />
    <R1MemoryPanel v-if="memoryOpen" :temporary="temporaryMode" @close="closePanels" />
    <R1HistoryPanel v-if="historyOpen" :temporary="temporaryMode" :assistant-name="persona?.assistantName || 'Seamo AI'" @close="closePanels" />
    <R1FocusDialog v-if="focusEditorOpen" :active="focus.active.value" :busy="focus.busy.value"
      :error="focus.error.value" :track="focusTargetTrack" @close="focusEditorOpen = false" @start="startFocus" />
    <aside v-if="focusNotice || (focus.error.value && !focusEditorOpen)" class="r1-reminder-toast" role="status">
      <p>{{ focusNotice || focus.error.value }}</p><button type="button" @click="focusNotice = ''; focus.error.value = ''">关闭</button>
    </aside>
    <aside v-if="reminderNotice" class="r1-reminder-toast" role="status">
      <div><strong>提醒已到期</strong><p>{{ reminderNotice.body }}</p>
        <small>{{ reminderNotice.systemRequested ? '系统通知已请求；不代表已读。' : '已在应用内显示；系统通知未请求。' }}</small>
      </div>
      <button type="button" @click="reminderNotice = null">关闭</button>
    </aside>
  </main>
</template>
