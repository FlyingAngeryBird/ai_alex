<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import MiniPlayer from '@/components/MiniPlayer.vue'
import MusicImmersiveView from '@/components/MusicImmersiveView.vue'
import ParticleSphere from '@/components/ParticleSphere.vue'
import R1SettingsPanel from '@/components/R1SettingsPanel.vue'
import R1MemoryPanel from '@/components/R1MemoryPanel.vue'
import R1MemoryConfirmationDialog from '@/components/R1MemoryConfirmationDialog.vue'
import R1ItemActionDialog from '@/components/R1ItemActionDialog.vue'
import type { MemoryConfirmation } from '../electron/main/r1/memoryConfirmations'
import R1TaskPanel from '@/components/R1TaskPanel.vue'
import { hasDismissiblePanel } from '@/services/panelDismissal'
import R1TaskCompletionNotice from '@/components/R1TaskCompletionNotice.vue'
import { useNativeConversation } from '@/composables/useNativeConversation'
import { useTasks } from '@/composables/useTasks'
import R1HistoryPanel from '@/components/R1HistoryPanel.vue'
import R1WelcomeDialog from '@/components/R1WelcomeDialog.vue'
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
import type { CredentialField, CredentialStatus } from '../electron/main/r1/credentials'
import { invokeWithTimeout } from './utils/invokeWithTimeout'
import { useAppPreferences } from './composables/useAppPreferences'
import { useSystemReducedMotion } from './composables/useSystemReducedMotion'
import { createAudioDevices } from './services/audioDevices'
import { createAssistantSpeech, type SpeechPurpose } from './services/assistantSpeech'
import { createTaskDeliveryCoordinator } from './services/taskDeliveryCoordinator'
import { withCaptureAbort } from './services/abortableCapture'
import { checkVoiceReadiness, voiceConfigurationMessage, type VoiceMode } from './services/voiceReadiness'

const conversation = useConversation()
const preferences = useAppPreferences()
const systemReducedMotion = useSystemReducedMotion()
const reducedMotion = computed(() => systemReducedMotion.value || Boolean(preferences.value.value?.reducedMotion))
const audioDevices = createAudioDevices({ mediaDevices: () => navigator.mediaDevices,
  inputId: () => preferences.value.value?.inputDeviceId ?? null, outputId: () => preferences.value.value?.outputDeviceId ?? null,
  onOutputFailure: handleOutputDeviceFailure })
const inputConstraints = () => audioDevices.inputConstraints({ channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true })
const keyboardRecorder = useKeyboardRecorder({ inputConstraints, onDeviceLost: handleInputDeviceLost })
const voicePreparing = ref(false)
const music = useMusic({ configureOutput: audioDevices.bindOutput })
watch(() => music.playback.value.status === 'playing' && music.playback.value.track
  ? `${music.playback.value.track.source ?? 'unknown'}:${music.playback.value.track.id}` : null, trackKey => {
  void window.seamoR1.focus.reportMusicSelection({ trackKey }).catch(() => undefined)
}, { immediate: true })
const focusNotice = ref('')
const focusDeliveryId = ref<string | null>(null)
const focus = useFocus(event => {
  const track = music.playback.value.track
  const currentTrackKey = track ? `${track.source ?? 'unknown'}:${track.id}` : null
  if (event.focus.endMusicRule === 'pause_user_selected_track' &&
    event.focus.endTargetTrackKey === currentTrackKey && music.playback.value.status === 'playing') {
    void music.pauseTrack(currentTrackKey!)
  }
  focusNotice.value = '这一段专注已完成，可以休息一下。'
  focusDeliveryId.value = event.deliveryId ?? null
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
  inputConstraints, onDeviceLost: handleInputDeviceLost,
  onPartialText: (text) => {
    conversationPartialText.value = text
  }
})
const assistantAudioLevel = ref(0.14)
const assistantAudioPlaying = ref(false)
const speechPurpose = ref<SpeechPurpose | null>(null)
let taskDeliveryCoordinator: ReturnType<typeof createTaskDeliveryCoordinator> | null = null
const speechPlayer = createAssistantSpeech({
  request: (text, voice) => invokeWithTimeout(window.lingli.invoke('tts.speak', { text, ...(voice ? { voice } : {}) }), 15000, '语音合成响应超时。'),
  canSpeakProactively: () => Boolean(preferences.value.value && !preferences.value.value.doNotDisturb && preferences.value.value.proactiveSpeechEnabled),
  configureOutput: audioDevices.bindOutput,
  onSpeaking(active) { assistantAudioPlaying.value = active; assistantAudioLevel.value = 0.14 },
  onEnded() { taskDeliveryCoordinator?.finished(); resumeAutoListenAfterAssistantAudio() }, mark: markVoiceTrace,
  onPurposeChange: purpose => { speechPurpose.value = purpose }
})
const nativeAutoRequested = ref(false)
const realtimeSearch = ref<import('../electron/main/r1/realtimeSearch').RealtimeSearchState | null>(null)
const realtimeSearchBusy = computed(() => !!realtimeSearch.value && ['searching', 'reading', 'waiting'].includes(realtimeSearch.value.phase))
const settingsPanel = ref<InstanceType<typeof R1SettingsPanel> | null>(null)
const taskPanel = ref<InstanceType<typeof R1TaskPanel> | null>(null)
const memoryConfirmation = ref<MemoryConfirmation | null>(null)
const itemAction = ref<import('../electron/main/r1/itemActions').ItemActionView | null>(null)
const itemActionBusy = ref(false)
const itemActionError = ref('')
const memoryConfirmationBusy = ref(false)
const memoryConfirmationError = ref('')
const memoryRevision = ref(0)
let stopMemoryChanged: (() => void) | null = null
let stopMemoryConfirmation: (() => void) | null = null
let stopItemAction: (() => void) | null = null
let nativeResumeGeneration: number | null = null
const nativeConversation = useNativeConversation({
  inputConstraints, configureOutput: audioDevices.bindOutput,
  checkReady: () => checkVoiceConfiguration('native'),
  onConfigurationRequired: code => openServiceSettings(code === 'REALTIME_VOICE_REQUIRED' ? 'VOLCENGINE_REALTIME_VOICE' : 'VOLCENGINE_REALTIME_API_KEY'),
  onSpeaking(value) { assistantAudioPlaying.value = value },
  onConnectionState(state) {
    if (!nativeAutoRequested.value) return
    conversation.setAutoListenState(state === 'ready' ? 'armed' : 'arming')
    conversation.particleState.value = 'idle'
    conversationPartialText.value = ''
  },
  onError(message) { nativeAutoRequested.value = false; nativeResumeGeneration = null; conversation.disableAutoListen(); conversation.particleState.value = 'idle'; conversationPartialText.value = ''; conversation.addSystemMessage(message) },
  onText(event) {
    if (event.type === 'conversation.item.input_audio_transcription.started' ||
      event.type === 'response.output_audio.delta' || event.type === 'response.output_text.delta') taskDeliveryCoordinator?.cancel()
    if (event.type === 'search.state') {
      realtimeSearch.value = event as unknown as import('../electron/main/r1/realtimeSearch').RealtimeSearchState
      if (['ready', 'timeout', 'cancelled', 'failed'].includes(realtimeSearch.value.phase) && !nativeConversation.userSpeaking.value) conversation.particleState.value = 'idle'
      return
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      conversationPartialText.value = typeof event.text === 'string' ? event.text : typeof event.delta === 'string' ? event.delta : ''
    } else if (event.type === 'conversation.item.input_audio_transcription.started') {
      realtimeSearch.value = null
      conversationPartialText.value = ''
      conversation.particleState.value = 'listening'
    } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      conversationPartialText.value = ''
      if (typeof event.transcript === 'string' && event.transcript.trim()) {
        const id = String(event.item_id)
        const existing = conversation.messages.value.find(message => message.id === id && message.role === 'user')
        if (existing) existing.text = event.transcript
        else conversation.messages.value.push({ id, role: 'user', text: event.transcript, createdAt: Date.now() })
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
watch(assistantAudioPlaying, active => { if (!active) void resumeNativeAfterText() })
watch(nativeConversation.active, active => { if (!active) realtimeSearch.value = null })
watch(() => preferences.value.value, (next, previous) => { if (next && previous && next.inputDeviceId !== previous.inputDeviceId) handleInputDeviceLost(true) })
watch(() => preferences.value.value?.outputDeviceId ?? null, () => { void audioDevices.routeOutputs() })
watch(() => [preferences.value.value?.doNotDisturb, preferences.value.value?.proactiveSpeechEnabled], () => speechPlayer.policyChanged())
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
const serviceConfigurationOpen = ref(false)
const serviceConfigurationField = ref<CredentialField>('VOLCENGINE_ARK_API_KEY')
const itemsOpen = ref(false)
const taskState = useTasks(window.seamoR1.tasks)
const taskOpen = ref(false)
const latestTaskCompletion = computed(() => taskState.completionNotices.value.at(-1) ?? null)
async function viewTaskCompletion(): Promise<void> {
  const notice = latestTaskCompletion.value
  if (!notice) return
  if (await openTask(notice.taskId)) taskState.dismissCompletion(notice.key)
}
async function openTask(targetId?: string): Promise<boolean> {
  if (!await prepareTaskPanelLeave()) return false
  closePanels()
  if (targetId) taskState.selectedId.value = targetId
  if (!taskState.selected.value) taskState.selectedId.value = taskState.tasks.value.at(-1)?.taskId ?? null
  taskOpen.value = true
  return true
}
const searchOpen = ref(false)
const searchEverOpened = ref(false)
const memoryOpen = ref(false)
const historyOpen = ref(false)
const textBusy = ref(false)
const composer = ref<InstanceType<typeof R1Composer> | null>(null)
const composerExtraHeight = ref(0)
const credentialStatus = ref<CredentialStatus | null>(null)
const credentialReadFailed = ref(false)
let credentialRetryTimer: number | null = null
let credentialRetryCount = 0
const persona = ref<R1Persona | null>(null)
const welcomeOpen = ref(false), welcomeBusy = ref(false), welcomeError = ref('')
async function finishWelcome(target: 'home' | 'settings' | 'services'): Promise<void> {
  if (welcomeBusy.value) return
  welcomeBusy.value = true; welcomeError.value = ''
  try {
    const result = await window.seamoR1.onboarding.complete({ skipped: target === 'home' })
    if (!result.ok) { welcomeError.value = result.error.message; return }
    welcomeOpen.value = false
    if (target === 'settings') openPanel('settings')
    else if (target === 'services') openServiceSettings('VOLCENGINE_ARK_API_KEY')
  } catch { welcomeError.value = '引导状态暂时无法保存，请重试。' }
  finally { welcomeBusy.value = false }
}
const currentDate = ref('')
let dateTimer: ReturnType<typeof setInterval> | undefined
function updateCurrentDate(): void { currentDate.value = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date()) }
onMounted(() => { updateCurrentDate(); dateTimer = setInterval(updateCurrentDate, 30_000) })
onBeforeUnmount(() => clearInterval(dateTimer))
const hasSidePanel = computed(() => settingsOpen.value || itemsOpen.value || memoryOpen.value || historyOpen.value)
const microphoneCapturing = computed(() => nativeConversation.active.value || keyboardRecorder.isRecording.value || realtimeRecorder.isRecording.value)
function applyCredentialStatus(credentials: Awaited<ReturnType<typeof window.seamoR1.credentials.status>>): boolean {
  if (credentials.ok) { credentialStatus.value = credentials.data; credentialReadFailed.value = false; credentialRetryCount = 0; return true }
  if (credentials.error.code === 'CREDENTIAL_LOAD_PENDING') { scheduleCredentialRetry(); return false }
  credentialReadFailed.value = true
  return false
}
function scheduleCredentialRetry(): void {
  if (credentialRetryTimer !== null) return
  if (credentialRetryCount >= 20) { credentialReadFailed.value = true; return }
  credentialRetryCount++
  credentialRetryTimer = window.setTimeout(async () => {
    credentialRetryTimer = null
    try { applyCredentialStatus(await window.seamoR1.credentials.status()) }
    catch { credentialReadFailed.value = true }
  }, 800)
}
const serviceLabel = computed(() => {
  if (voicePreparing.value) return '正在准备语音，松开可取消…'
  const status = credentialStatus.value
  if (!status) return credentialReadFailed.value ? '服务状态读取失败 · 前往设置' : '正在读取服务配置…'
  const text = status.VOLCENGINE_ARK_API_KEY && status.VOLCENGINE_ARK_MODEL
  const voice = status.VOLCENGINE_REALTIME_API_KEY && (persona.value?.voiceId || status.VOLCENGINE_REALTIME_VOICE)
  return text && voice ? '文字与实时语音已配置 · 待实际连接' : text ? '文字已配置 · 实时语音待配置'
    : voice ? '文字待配置 · 实时语音已配置' : '对话服务未配置 · 前往设置'
})

async function prepareTaskPanelLeave(): Promise<boolean> {
  if (settingsOpen.value && settingsPanel.value && !settingsPanel.value.canLeave()) return false
  if (!taskOpen.value) return true
  try {
    const saved = await (taskPanel.value?.flushEditing() ?? true)
    if (!saved) { conversation.addSystemMessage('工作稿修改尚未保存，任务面板保持打开；请先保存或撤销。'); return false }
    return true
  } catch { conversation.addSystemMessage('任务面板暂时无法保存，请先保存或撤销修改后重试。'); return false }
}
async function closeTaskPanel(): Promise<void> {
  if (!await prepareTaskPanelLeave()) return
  taskOpen.value = false
}
async function leaveTaskPanel(action?: () => void): Promise<void> {
  if (!await prepareTaskPanelLeave()) return
  action?.()
  closePanels()
}
async function openPanel(panel: 'settings' | 'items' | 'search' | 'memory' | 'history'): Promise<void> {
  if (!await prepareTaskPanelLeave()) return
  serviceConfigurationOpen.value = false
  taskOpen.value = false
  settingsOpen.value = panel === 'settings'
  itemsOpen.value = panel === 'items'
  searchOpen.value = panel === 'search'
  memoryOpen.value = panel === 'memory'
  historyOpen.value = panel === 'history'
  if (panel === 'search') searchEverOpened.value = true
}
async function openServiceSettings(field: CredentialField = 'VOLCENGINE_ARK_API_KEY'): Promise<void> {
  await openPanel('settings')
  if (!settingsOpen.value) return
  serviceConfigurationField.value = field; serviceConfigurationOpen.value = true
}
async function checkVoiceConfiguration(mode: VoiceMode): Promise<void> {
  try { credentialStatus.value = await checkVoiceReadiness(window.seamoR1, mode); credentialReadFailed.value = false }
  catch (error) { throw new Error(error instanceof Error && voiceConfigurationMessage(error.message) ? error.message : 'VOICE_CONFIGURATION_UNAVAILABLE') }
}

function closePanels(): boolean {
  if (settingsOpen.value && settingsPanel.value && !settingsPanel.value.canLeave()) return false
  taskOpen.value = false
  settingsOpen.value = false
  itemsOpen.value = false
  searchOpen.value = false
  memoryOpen.value = false
  historyOpen.value = false
  return true
}
const temporaryMode = ref(false)
const lastNormalTopic = ref<string | null>(null)
async function refreshLastNormalTopic(): Promise<void> {
  if (temporaryMode.value) { lastNormalTopic.value = null; return }
  try {
    const result = await window.seamoR1.history.list({ page: 0 })
    if (!result.ok) { lastNormalTopic.value = null; return }
    const latest = result.data.sessions.find(session => session.messageCount > 0 && session.title.trim())
    lastNormalTopic.value = latest?.title.trim() ?? null
  } catch { lastNormalTopic.value = null }
}
watch([temporaryMode, () => conversation.messages.value.length], () => {
  if (temporaryMode.value) lastNormalTopic.value = null
  else if (conversation.messages.value.length === 0) void refreshLastNormalTopic()
})
watch(welcomeOpen, open => { if (!open) void refreshLastNormalTopic() })
const reminderNotice = ref<import('../electron/main/r1/reminderScheduler').ReminderDueEvent | null>(null)
let stopReminderNotice: (() => void) | null = null
let stopMemoryInvalidation: (() => void) | null = null
const voicePreviewPending = ref(false)
const voicePreviewing = computed(() => voicePreviewPending.value || speechPurpose.value === 'preview' && assistantAudioPlaying.value)
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
  start: async (signal) => {
    clearAutoListenRecoveryTimer()
    clearAutoListenGraceTimer()
    if (activeVoiceInputMode === 'auto_listen') {
      await cancelActiveVoiceCapture()
    }
    voiceStartPromise = startVoiceCapture(signal)
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
  inputConstraints, onDeviceLost: handleInputDeviceLost,
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

watch([assistantAudioPlaying, nativeConversation.userSpeaking, realtimeRecorder.userSpeaking, keyboardRecorder.userSpeaking, () => autoListen.diagnostics.value.speaking],
  ([assistant, native, realtime, keyboard, auto]) => music.setSpeechActive(assistant || native || realtime || keyboard || auto))

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
  if (realtimeSearchBusy.value && !nativeConversation.userSpeaking.value && !assistantAudioPlaying.value) return 'thinking'
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
  if (realtimeSearchBusy.value && !nativeConversation.userSpeaking.value && !assistantAudioPlaying.value) return 'thinking'
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
  taskDeliveryCoordinator?.cancel()
  if (nativeConversation.active.value) void nativeConversation.interrupt()
  conversation.stopCurrentReply()
  void window.lingli.invoke('chat.stopResponse')
  releaseAssistantAudio(true)
}

function releaseAssistantAudio(resumeAutoListen = false): void { speechPlayer.stop(resumeAutoListen) }

async function speakAssistantReply(text?: string, voiceOverride?: string, purpose: SpeechPurpose = 'reply'): Promise<void> {
  if (!text?.trim() || !window.lingli) { resumeAutoListenAfterAssistantAudio(); return }
  if (!preferences.value.value && !await preferences.load()) return
  const voiceId = voiceOverride?.trim() || persona.value?.voiceId.trim() || ''
  await speechPlayer.speak(text, voiceId || undefined, purpose)
}

function handleInputDeviceLost(changed = false): void {
  const wasCapturing = nativeConversation.active.value || nativeConversation.starting.value || keyboardRecorder.isRecording.value || realtimeRecorder.isRecording.value || pushToTalk.isBusy() || autoListen.enabled.value
  nativeAutoRequested.value = false; nativeResumeGeneration = null; ++autoListenModeGeneration
  void nativeConversation.stop(); autoListen.stop(); void pushToTalk.cancel(); void cancelActiveVoiceCapture()
  conversation.disableAutoListen()
  conversationPartialText.value = ''
  conversation.cancelVoiceInput('', { silent: true })
  conversation.addSystemMessage(changed ? wasCapturing ? '输入设备已更新，当前收音已停止。可以重新开启语音。' : '输入设备已保存，下次开启语音时使用。' : '麦克风已断开，请选择可用设备后重试；文字仍可使用。')
}
function handleOutputDeviceFailure(): void {
  releaseAssistantAudio()
  nativeAutoRequested.value = false; nativeResumeGeneration = null; ++autoListenModeGeneration
  void nativeConversation.stop(); autoListen.stop(); void pushToTalk.cancel(); void cancelActiveVoiceCapture()
  conversation.disableAutoListen(); conversationPartialText.value = ''; conversation.cancelVoiceInput('', { silent: true })
  music.outputFailed()
  conversation.addSystemMessage('输出设备切换未成功，已停止播音。请重新选择设备，或使用文字继续。')
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

async function ensureMicrophoneAccess(signal?: AbortSignal): Promise<void> {
  const api = window.lingli

  if (!api) {
    throw new Error('语音通道不可用，请确认从 Seamo AI R1 桌面应用启动。')
  }

  const result = await withCaptureAbort(invokeWithTimeout(
    api.invoke<MicrophoneAccessResult>('app.requestMicrophoneAccess'),
    6000,
    '麦克风权限请求超时。'
  ), signal)

  if (!result.ok) {
    throw new Error(result.error.message)
  }

  if (!result.data.granted) {
    throw new Error(`麦克风权限未开启（${result.data.status}）`)
  }
}

async function startVoiceCapture(signal?: AbortSignal): Promise<boolean> {
  voicePreparing.value = true
  try { return await openVoiceCapture(signal) }
  finally { voicePreparing.value = false }
}
async function openVoiceCapture(signal?: AbortSignal): Promise<boolean> {
  releaseAssistantAudio()

  try {
    if (!preferences.value.value && !await withCaptureAbort(preferences.load(), signal)) throw new Error('偏好暂时无法读取，请稍后重试；文字仍可使用。')
    await withCaptureAbort(checkVoiceConfiguration('pushToTalk'), signal)
    await ensureMicrophoneAccess(signal)
    if (signal?.aborted) return false
    conversation.startListening()
  } catch (error) {
    if (signal?.aborted) { conversation.cancelVoiceInput('', { silent: true }); return false }
    const configuration = error instanceof Error && voiceConfigurationMessage(error.message)
    if (configuration) openServiceSettings('VOLCENGINE_STREAM_ASR_API_KEY')
    conversation.markVoiceError(configuration || getVoiceErrorMessage(error))
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

    await realtimeRecorder.start({ initialAudio, stream: autoListenStream, signal })
    return true
  } catch (error) {
    if (signal?.aborted) { conversation.cancelVoiceInput('', { silent: true }); return false }
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
      await keyboardRecorder.start(signal)
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
      if (error instanceof Error && error.message === 'VOICE_CAPTURE_CANCELLED') { conversation.cancelVoiceInput('', { silent: true }); return }
      conversation.cancelVoiceInput(getVoiceErrorMessage(error))
      recoverAutoListenAfterVoiceCancel()
      return
    }
  } else if (keyboardRecorder.isRecording.value) {
    try {
      const transcription = await keyboardRecorder.stopAndTranscribe()
      text = transcription.text
    } catch (error) {
      if (error instanceof Error && error.message === 'VOICE_CAPTURE_CANCELLED') { conversation.cancelVoiceInput('', { silent: true }); return }
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
  const generation = ++autoListenModeGeneration
  nativeResumeGeneration = null
  if (nativeAutoRequested.value) {
    nativeAutoRequested.value = false
    await nativeConversation.stop()
    conversation.disableAutoListen()
    conversation.particleState.value = 'idle'
    conversationPartialText.value = ''
    return
  }
  if (!preferences.value.value && !await preferences.load()) { conversation.addSystemMessage('偏好暂时无法读取，请稍后重试；文字仍可使用。'); return }
  nativeAutoRequested.value = true
  if (textBusy.value || assistantAudioPlaying.value) {
    nativeResumeGeneration = generation; conversation.setAutoListenState('arming'); return
  }
  await pushToTalk.cancel()
  await pushToTalk.whenIdle()
  autoListen.stop()
  clearAutoListenGraceTimer()
  clearAutoListenRecoveryTimer()
  if (credentialRetryTimer !== null) { window.clearTimeout(credentialRetryTimer); credentialRetryTimer = null }
  releaseAssistantAudio()
  conversation.stopCurrentReply()
  await window.lingli.invoke('chat.stopResponse')
  if (!nativeAutoRequested.value || generation !== autoListenModeGeneration) return
  conversation.setAutoListenState('arming')
  const started = await nativeConversation.start()
  if (generation !== autoListenModeGeneration || !nativeAutoRequested.value) { if (started) await nativeConversation.stop(); return }
  if (started) conversation.setAutoListenState('armed')
  else { nativeAutoRequested.value = false; conversation.disableAutoListen() }
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
  if (event.defaultPrevented || memoryConfirmation.value || document.querySelector('[aria-modal="true"]')) return
  if (event.key === 'Escape') {
    if (itemAction.value || welcomeOpen.value) return
    if (taskOpen.value) {
      event.preventDefault()
      void closeTaskPanel().then(() => { if (!taskOpen.value) composer.value?.focusInput() })
      return
    }
    if (hasDismissiblePanel({ settingsOpen: settingsOpen.value, itemsOpen: itemsOpen.value,
      memoryOpen: memoryOpen.value, historyOpen: historyOpen.value, searchOpen: searchOpen.value })) {
      event.preventDefault()
      if (closePanels()) composer.value?.focusInput()
    }
    return
  }
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
  if (nativeAutoRequested.value) {
    nativeAutoRequested.value = false; nativeResumeGeneration = null; ++autoListenModeGeneration
    await nativeConversation.stop(); conversation.disableAutoListen(); conversation.stopCurrentReply()
  }
  await pushToTalk.press(source)
}
async function endPushToTalk(source: PushToTalkSource = 'button'): Promise<void> { await pushToTalk.release(source) }
function cancelPushToTalk(): void { void pushToTalk.cancel() }
function handleWindowBlur(): void { cancelPushToTalk() }
function handleVisibilityChange(): void { if (document.hidden) cancelPushToTalk() }

async function handleContinueTopic(topic: import('../electron/main/r1/topics').R1Topic): Promise<void> {
  nativeAutoRequested.value = false; nativeResumeGeneration = null; ++autoListenModeGeneration
  await nativeConversation.stop(); conversation.disableAutoListen(); releaseAssistantAudio()
  if (!await prepareTaskPanelLeave()) return
  closePanels(); music.closeImmersive()
  await handleSendText(`接着「${topic.title}」聊`)
}
async function handleSendText(text: string, complete?: (accepted: boolean) => void): Promise<void> {
  if (textBusy.value || conversation.isListening.value ||
    conversation.particleState.value === 'thinking' && !nativeConversation.active.value) {
    complete?.(false)
    return
  }
  textBusy.value = true
  const resumeGeneration = nativeAutoRequested.value ? autoListenModeGeneration : null
  await nativeConversation.stop()
  conversation.stopCurrentReply()
  if (nativeAutoRequested.value) conversation.setAutoListenState('arming')
  else conversation.disableAutoListen()
  releaseAssistantAudio()
  try {
    if (taskPanel.value && !await taskPanel.value.flushEditing()) {
      const cleared = await window.seamoR1.artifacts.select({ artifactId: null, expectedVersion: null, selection: null })
      if (!cleared.ok) { complete?.(false); conversation.addSystemMessage('当前稿件上下文未能更新，请重试发送。'); return }
      conversation.addSystemMessage('工作稿的修改尚未保留，当前对话暂不引用它。你的文字仍在编辑器中，可以继续聊天。')
    }
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
  } finally {
    textBusy.value = false
    if (resumeGeneration !== null && nativeAutoRequested.value && resumeGeneration === autoListenModeGeneration) {
      nativeResumeGeneration = resumeGeneration
      void resumeNativeAfterText()
    }
  }
}

async function resumeNativeAfterText(): Promise<void> {
  const generation = nativeResumeGeneration
  if (generation === null || textBusy.value || assistantAudioPlaying.value) return
  nativeResumeGeneration = null
  if (!nativeAutoRequested.value || generation !== autoListenModeGeneration) return
  conversation.setAutoListenState('arming')
  if (await nativeConversation.start()) {
    if (nativeAutoRequested.value && generation === autoListenModeGeneration) conversation.setAutoListenState('armed')
    else await nativeConversation.stop()
  } else { nativeAutoRequested.value = false; conversation.disableAutoListen() }
}

async function handleToggleTemporary(): Promise<void> {
  if (conversation.isListening.value || assistantAudioPlaying.value ||
    conversation.particleState.value === 'thinking') {
    conversation.addSystemMessage('请先结束当前语音或等待回答结束，再切换临时对话。')
    return
  }
  nativeAutoRequested.value = false; nativeResumeGeneration = null; ++autoListenModeGeneration
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

async function prepareMemorySelection(input: { content: string; category: 'profile' | 'preference' | 'ongoing' | 'conclusion' }): Promise<void> {
  const pending = memoryConfirmation.value
  if (!pending?.requiresSelection || memoryConfirmationBusy.value) return
  memoryConfirmationBusy.value = true; memoryConfirmationError.value = ''
  try {
    const result = await window.seamoR1.memory.prepareSelection({ confirmationId: pending.confirmationId, ...input })
    if (result.ok) {
      if (!memoryConfirmation.value || memoryConfirmation.value.confirmationId === pending.confirmationId) memoryConfirmation.value = result.data
    } else if (memoryConfirmation.value?.confirmationId === pending.confirmationId) {
      memoryConfirmationError.value = result.error.code === 'MEMORY_SELECTION_NOT_FROM_SOURCE' ? '请选取上面原话中的连续一段内容。' : '选取未完成。请检查内容，或取消后重新发起。'
    }
  } catch { if (memoryConfirmation.value?.confirmationId === pending.confirmationId) memoryConfirmationError.value = '选取未完成，请重试。' }
  finally { memoryConfirmationBusy.value = false }
}

async function resolveItemAction(decision: 'delete' | 'export' | 'cancel', disposition?: 'keep' | 'cancel'): Promise<void> {
  const pending = itemAction.value
  if (!pending || itemActionBusy.value) return
  itemActionBusy.value = true; itemActionError.value = ''
  try {
    const result = await window.seamoR1.items.resolveAction({ ticket: pending.ticket, decision,
      ...(disposition ? { reminderDisposition: disposition } : {}) })
    if (!result.ok) {
      const code = result.error.code
      const message = code === 'TASK_RECEIPT_LINK_FAILED' ? '事项已删除，但任务记录关联失败；请重试关联，不要重复删除。'
        : code === 'EXPORT_FILE_WRITTEN_RECEIPT_FAILED' ? '文件已写出，但导出回执未能保存。请检查所选位置，不要重复导出。'
        : ['ITEM_ACTION_STALE', 'VERSION_CONFLICT', 'REMINDER_CONFIRMATION_STALE'].includes(code) ? '这一项已有新的修改，请关闭后重新提出请求。'
          : code === 'ITEM_ACTION_EXPIRED' ? '这次确认已过期，请重新提出请求。'
            : ['ITEM_ACTION_SESSION_CHANGED', 'ITEM_ACTION_TASK_STALE', 'ITEM_ACTION_NOT_FOUND', 'ITEM_ACTION_OWNER_MISMATCH',
              'TASK_CANCELLED', 'TASK_STEERED', 'TASK_SUSPENDED', 'TASK_CONTEXT_INVALIDATED', 'TEMPORARY_ENDED'].includes(code) ? '这次确认已失效，请重新提出请求。'
              : decision === 'export' ? '导出未完成，请检查版本和保存位置后重试。' : '删除未完成，请重试；事项仍然保留。'
      if (['ITEM_ACTION_EXPIRED', 'ITEM_ACTION_SESSION_CHANGED', 'ITEM_ACTION_TASK_STALE', 'ITEM_ACTION_NOT_FOUND', 'ITEM_ACTION_OWNER_MISMATCH',
        'TASK_CANCELLED', 'TASK_STEERED', 'TASK_SUSPENDED', 'TASK_CONTEXT_INVALIDATED', 'TEMPORARY_ENDED'].includes(code)) {
        if (itemAction.value?.ticket === pending.ticket) itemAction.value = null
        conversation.addSystemMessage(message)
      } else if (itemAction.value?.ticket === pending.ticket) itemActionError.value = message
      else conversation.addSystemMessage(message)
      return
    }
    if (itemAction.value?.ticket === pending.ticket) itemAction.value = null
    const data = result.data as { cancelled?: boolean; path?: string }
    if (data.cancelled) return
    conversation.addSystemMessage(decision === 'delete' ? '事项已按你的选择删除；关联提醒的去留以刚才的选择为准。'
      : '已导出你确认的版本。')
  } catch {
    if (itemAction.value?.ticket === pending.ticket) itemActionError.value = decision === 'export' ? '导出未完成，请重试。' : '删除未完成，请重试。'
  } finally { itemActionBusy.value = false }
}

async function resolveMemoryConfirmation(save: boolean): Promise<void> {
  const pending = memoryConfirmation.value
  if (!pending || memoryConfirmationBusy.value) return
  memoryConfirmationBusy.value = true; memoryConfirmationError.value = ''
  try {
    // Stop the awaiting-confirmation narration without revoking the user's confirmation authority.
    releaseAssistantAudio()
    if (nativeConversation.active.value) await nativeConversation.interrupt().catch(() => undefined)
    if (!save) {
      const result = await window.seamoR1.memory.cancelSave(pending.confirmationId)
      if (!result.ok && result.error.code !== 'MEMORY_CONFIRMATION_NOT_FOUND') throw new Error('取消未完成，请重试。')
      if (memoryConfirmation.value?.confirmationId === pending.confirmationId) memoryConfirmation.value = null
      return
    }
    const result = await window.seamoR1.memory.confirmSave(pending.confirmationId)
    if (!result.ok) {
      const message = result.error.code === 'VERSION_CONFLICT' ? '这条记忆已有新版本，请取消后重新发起更正。' :
        ['MEMORY_CONFIRMATION_STALE', 'MEMORY_CONFIRMATION_EXPIRED', 'MEMORY_CONFIRMATION_NOT_FOUND'].includes(result.error.code) ? '这次确认已失效，请重新提出保存请求。' : '记忆没有保存成功，请重试。'
      if (memoryConfirmation.value?.confirmationId === pending.confirmationId) memoryConfirmationError.value = message
      else conversation.addSystemMessage(message)
      return
    }
    if (result.data.sessionChanged) {
      nativeAutoRequested.value = false; nativeResumeGeneration = null; ++autoListenModeGeneration
      await nativeConversation.stop(); conversation.disableAutoListen(); releaseAssistantAudio()
      if (startupGreetingTimer !== null) { window.clearTimeout(startupGreetingTimer); startupGreetingTimer = null }
      conversation.resetConversation(); temporaryMode.value = false; taskState.changeScope(); taskOpen.value = false
    }
    memoryRevision.value++
    if (memoryConfirmation.value?.confirmationId === pending.confirmationId) memoryConfirmation.value = null
    conversation.addSystemMessage(result.data.sessionChanged ? '已退出临时对话，只保存了你确认的这条记忆。其余临时聊天已清除。' : pending.operation === 'update' ? '这条记忆已更正。' : '这条记忆已保存。')
  } catch (error) { memoryConfirmationError.value = error instanceof Error ? error.message : '记忆没有保存成功，请重试。' }
  finally { memoryConfirmationBusy.value = false }
}

async function handlePreviewVoice(voiceId: string): Promise<void> {
  nativeAutoRequested.value = false; nativeResumeGeneration = null; ++autoListenModeGeneration
  await nativeConversation.stop()
  conversation.disableAutoListen()
  voicePreviewPending.value = true

  try {
    await speakAssistantReply('你好，这是当前的音色试听。', voiceId, 'preview')
  } finally {
    voicePreviewPending.value = false
  }
}

const speechRequests = new Map<string, 'reminder' | 'task'>()
taskDeliveryCoordinator = createTaskDeliveryCoordinator({
  prepare: input => {
    const reminder = 'deliveryId' in input
    speechRequests.set(input.requestId, reminder ? 'reminder' : 'task')
    return reminder ? window.seamoR1.reminders.prepareDelivery(input) : window.seamoR1.tasks.prepareDelivery(input)
  },
  cancel: requestId => {
    const api = speechRequests.get(requestId) === 'reminder' ? window.seamoR1.reminders : window.seamoR1.tasks
    void api.cancelDelivery({ requestId }).catch(() => undefined)
    speechRequests.delete(requestId)
  },
  async play(result, report) {
    conversation.messages.value.push({ id: result.responseId, role: 'assistant', text: result.text, createdAt: Date.now() })
    await speechPlayer.speak(result.text, undefined, 'proactive', { ok: true, data: result }, report)
  },
  report: input => {
    const api = speechRequests.get(input.requestId) === 'reminder' ? window.seamoR1.reminders : window.seamoR1.tasks
    void api.reportDeliveryPlayback(input).catch(() => undefined)
    if (input.status === 'completed') speechRequests.delete(input.requestId)
  },
  stop() { if (speechPurpose.value === 'proactive') releaseAssistantAudio(true) }
})
watch(() => ({ notice: reminderNotice.value ? reminderNotice.value.deliveryId ? { key: reminderNotice.value.deliveryId, deliveryId: reminderNotice.value.deliveryId } : null :
    focusNotice.value ? focusDeliveryId.value ? { key: focusDeliveryId.value, deliveryId: focusDeliveryId.value } : null : latestTaskCompletion.value,
  allowed: Boolean(preferences.value.value?.proactiveSpeechEnabled && !preferences.value.value.doNotDisturb &&
    !welcomeOpen.value && !memoryConfirmation.value &&
    !textBusy.value && !voicePreparing.value && !voicePreviewPending.value && !conversation.isListening.value &&
    !nativeConversation.userSpeaking.value && !nativeConversation.speaking.value && !nativeConversation.starting.value &&
    !realtimeRecorder.userSpeaking.value && !keyboardRecorder.userSpeaking.value && !autoListen.diagnostics.value.speaking &&
    !realtimeSearchBusy.value && conversation.particleState.value === 'idle' &&
    (!assistantAudioPlaying.value || speechPurpose.value === 'proactive')),
  temporary: temporaryMode.value, personaVersion: persona.value?.version
}), (next, previous) => {
  if (previous && (next.temporary !== previous.temporary || next.personaVersion !== previous.personaVersion)) taskDeliveryCoordinator?.cancel()
  taskDeliveryCoordinator?.update(next.notice, next.allowed)
}, { flush: 'sync' })

onMounted(() => {
  void refreshLastNormalTopic()
  window.setTimeout(() => { if (!lastNormalTopic.value && !temporaryMode.value) void refreshLastNormalTopic() }, 1000)
  stopItemAction = window.seamoR1.items.onAction(value => {
    itemAction.value = value
    itemActionBusy.value = false
    itemActionError.value = ''
  })
  stopMemoryConfirmation = window.seamoR1.memory.onConfirmation(value => {
    memoryConfirmation.value = value; memoryConfirmationError.value = ''
  })
  stopMemoryChanged = window.seamoR1.memory.onChanged(() => { memoryRevision.value++ })
  taskState.start()
  try { audioDevices.start() } catch { audioDevices.error.value = '设备列表暂时无法读取，请稍后在设置中重试。' }
  void Promise.all([window.seamoR1.credentials.status(), window.seamoR1.persona.get(), preferences.load(), window.seamoR1.onboarding.get()]).then(([credentials, currentPersona, preferencesReady, onboarding]) => {
    if (onboarding.ok) welcomeOpen.value = !onboarding.data.completed
    else conversation.addSystemMessage('首次引导状态暂时无法读取，可在设置中重新打开使用说明。')
    const credentialsReady = applyCredentialStatus(credentials)
    if (currentPersona.ok) persona.value = currentPersona.data
    else conversation.addSystemMessage('人格设置暂时无法读取，请重新启动应用。')
    if (welcomeOpen.value || !onboarding.ok || !preferencesReady || !credentialsReady || !currentPersona.ok ||
      !credentialStatus.value?.VOLCENGINE_ARK_API_KEY || !credentialStatus.value?.VOLCENGINE_ARK_MODEL) return
    startupGreetingTimer = window.setTimeout(() => {
      if (conversation.messages.value.length || conversation.isListening.value || nativeConversation.active.value || nativeConversation.starting.value) return
      void conversation.generateOpeningGreeting().then(() => {
        const greeting = conversation.messages.value[0]
        if (greeting?.role === 'assistant' && conversation.messages.value.length === 1) {
          void speakAssistantReply(greeting.text, undefined, 'proactive')
        }
      })
    }, 900)
  }).catch(() => { credentialReadFailed.value = true; conversation.addSystemMessage('启动配置暂时无法读取，可以在设置中重试；本地页面仍可使用。') })
  stopReminderNotice = window.seamoR1?.reminders.onDue((event) => {
    reminderNotice.value = event
  }) ?? null
  stopMemoryInvalidation = window.seamoR1.memory.onInvalidated(() => {
    taskDeliveryCoordinator?.cancel()
    taskState.clearCompletionNotices()
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
  taskDeliveryCoordinator?.dispose()
  nativeAutoRequested.value = false; nativeResumeGeneration = null; ++autoListenModeGeneration
  void nativeConversation.stop()
  taskState.dispose()
  audioDevices.dispose(); preferences.dispose()
  void pushToTalk.dispose()
  window.removeEventListener('blur', handleWindowBlur)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  stopMemoryInvalidation?.()
  stopMemoryConfirmation?.()
  stopItemAction?.()
  stopMemoryChanged?.()
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
  <main class="r1-shell" :data-view="viewMode" :class="{ 'r1-has-side-panel': hasSidePanel, 'r1-has-wide-panel': searchOpen || taskOpen, 'r1-reduce-motion': reducedMotion }">
    <header class="r1-app-header">
      <button class="r1-brand" type="button" @click="leaveTaskPanel(() => music.closeImmersive())"
        aria-label="返回 Seamo 陪伴首页"><AudioLines :size="25" /><span>Seamo <em>AI</em></span></button>
      <time>{{ currentDate }}</time>
      <div class="r1-header-right"><button v-if="taskState.tasks.value.length && !taskOpen" type="button" class="r1-header-task" @click="openTask()">查看委托</button><span class="r1-mic-state"><Mic v-if="microphoneCapturing" :size="14" /><MicOff v-else :size="14" />{{ microphoneCapturing ? '正在收音' : '麦克风未开启' }}</span></div>
    </header>
    <nav class="r1-rail" aria-label="主导航">
      <button type="button" :aria-current="viewMode === 'conversation' && !hasSidePanel && !searchOpen ? 'page' : undefined"
        aria-label="陪伴" @click="leaveTaskPanel(() => music.closeImmersive())"><MessageCircle :size="20" /><span>陪伴</span></button>
      <button type="button" :aria-current="viewMode === 'music' ? 'page' : undefined"
        aria-label="音乐" @click="leaveTaskPanel(() => music.openImmersive())"><Headphones :size="20" /><span>音乐</span></button>
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
    <section class="r1-main-space" :style="{ '--r1-composer-extra': `${composerExtraHeight}px` }" aria-label="Seamo 陪伴空间">
      <R1FocusChip v-if="focus.active.value && focus.state.value" :focus="focus.state.value" :busy="focus.busy.value"
        @pause="focus.control('pause')" @resume="focus.control('resume')" @stop="focus.control('stop')" />
      <div class="r1-particle-space" :data-mode="viewMode">
        <ParticleSphere :state="reducedMotion ? 'idle' : particleState" :audio-level="reducedMotion ? 0 : audioLevel" :audio-bands="music.audioBands.value" />
      </div>
      <MiniPlayer v-if="viewMode === 'conversation' && music.hasActiveTrack.value"
        class="r1-ambient-player" :playback="music.playback.value"
        @open="music.openImmersive" @toggle-playback="music.togglePlayback" />
      <Transition name="view-fade" mode="out-in">
      <MusicImmersiveView
        v-if="viewMode === 'music'"
        :active-tab="music.activeTab.value"
        :queue="music.queueEntries.value" :queue-version="music.queueVersion.value" :temporary="temporaryMode" :notice="music.musicNotice.value"
        @seek="music.seek" @add-queue="music.addToQueue" @remove-queue="music.removeQueue" @move-queue="music.moveQueue" @feedback="music.feedbackAndSkip"
        :volume="music.volume.value" :assistant-speaking="assistantAudioPlaying" @volume-change="music.setVolume"
        :favorites="music.favorites.value"
        :playback="music.playback.value"
        :search-history="music.searchHistory.value"
        :search-query="music.searchQuery.value"
        :search-results="music.searchResults.value"
        :search-results-visible="music.searchResultsVisible.value"
        :search-busy="music.searchBusy.value" :search-sources="music.searchSources.value"
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
          :allow-text-interrupt="nativeConversation.active.value && !textBusy"
        :assistant-name="persona?.assistantName || 'Seamo AI'"
          :messages="conversation.messages.value"
          :state="conversationPanelState"
          :partial-text="conversationPartialText"
          :temporary-mode="temporaryMode"
          :search-state="realtimeSearch"
          :last-topic="lastNormalTopic"
          @open-history="openPanel('history')"
          @open-search="openPanel('search')"
          @start-chat="composer?.focusInput()"
          @send-prompt="handleSendText"
          @resume-topic="(title) => handleSendText(`接着「${title}」聊`)"
        />
    </Transition>
      <R1Composer ref="composer" :auto-listen-state="conversation.autoListenState.value"
        :allow-text-interrupt="nativeConversation.active.value && !textBusy"
        :assistant-name="persona?.assistantName || 'Seamo AI'"
        :busy="textBusy || conversation.isListening.value || conversation.particleState.value === 'thinking' || assistantAudioPlaying"
        :is-listening="conversation.isListening.value" :temporary-mode="temporaryMode"
        :service-label="serviceLabel" :music-active="viewMode === 'music'"
        @layout-height="(extra) => { composerExtraHeight = extra }"
        @send="handleSendText" @voice-press-start="beginPushToTalk()" @voice-press-end="endPushToTalk()" @voice-press-cancel="cancelPushToTalk"
        @toggle-temporary="handleToggleTemporary" @toggle-auto-listen="toggleAutoListen"
        @open-service-settings="openServiceSettings"
        @stop-speech="stopCurrentResponse" />
    </section>

    <R1TaskPanel ref="taskPanel" v-show="taskOpen" :active="taskOpen" :tasks="taskState.tasks.value" :selected="taskState.selected.value"
      :busy="taskState.busy.value" :loading="taskState.loading.value" :error="taskState.error.value"
      @close="closeTaskPanel" @select="(id) => { taskState.selectedId.value = id }"
      @control="taskState.control" @retry="taskState.refresh" />
    <R1SettingsPanel ref="settingsPanel" :devices="audioDevices" :system-reduced-motion="systemReducedMotion" :diagnostic-trace="() => ({ ...getLastLatencyTrace(), nativeVoice: nativeConversation.getDiagnostics() })" :native-diagnostics="nativeConversation.getDiagnostics" @open-history="openPanel('history')"
      :show-service-configuration="serviceConfigurationOpen"
      :service-configuration-field="serviceConfigurationField"
      v-if="settingsOpen"
      :persona="persona"
      :voice-previewing="voicePreviewing"
      @close="closePanels"
      @preview-voice="handlePreviewVoice"
      @saved="(saved) => { persona = saved }"
      @credentials-changed="(status) => { credentialStatus = status }"
      @show-welcome="welcomeOpen = true"
    />
    <R1ItemsPanel v-if="itemsOpen" :temporary-mode="temporaryMode" @close="closePanels" @start-focus="openFocusEditor" />
    <R1WelcomeDialog v-if="welcomeOpen" :busy="welcomeBusy" :error="welcomeError"
      :native-configured="!!credentialStatus?.VOLCENGINE_REALTIME_API_KEY && !!(persona?.voiceId || credentialStatus?.VOLCENGINE_REALTIME_VOICE)"
      :text-configured="!!credentialStatus?.VOLCENGINE_ARK_API_KEY && !!credentialStatus?.VOLCENGINE_ARK_MODEL" @complete="finishWelcome" />
    <SearchPanel v-if="searchEverOpened" v-show="searchOpen" :temporary-mode="temporaryMode" @close="closePanels" />
    <R1MemoryPanel v-if="memoryOpen" :temporary="temporaryMode" :revision="memoryRevision" :interaction-busy="textBusy || conversation.isListening.value || conversation.particleState.value === 'thinking'" @close="closePanels" @continue-topic="handleContinueTopic" @settings="openPanel('settings')" />
    <R1MemoryConfirmationDialog v-if="memoryConfirmation" :key="memoryConfirmation.confirmationId" :confirmation="memoryConfirmation"
      :busy="memoryConfirmationBusy" :error="memoryConfirmationError" @selection="prepareMemorySelection" @confirm="resolveMemoryConfirmation(true)" @cancel="resolveMemoryConfirmation(false)" />
    <R1ItemActionDialog v-if="itemAction" :key="itemAction.ticket" :action="itemAction.action"
      :item-title="itemAction.data.item?.title ?? ''" :reminders="itemAction.data.reminders"
      :items="itemAction.data.items" :artifact-title="itemAction.data.artifact?.title"
      :format="itemAction.data.format" :busy="itemActionBusy" :error="itemActionError"
      :expires-at="itemAction.expiresAt" @close="resolveItemAction('cancel')"
      @keep="resolveItemAction('delete', 'keep')" @cancel-reminders="resolveItemAction('delete', 'cancel')"
      @export="resolveItemAction('export')" />
    <R1HistoryPanel v-if="historyOpen" :temporary="temporaryMode" :allow-text-interrupt="nativeConversation.active.value && !textBusy"
        :assistant-name="persona?.assistantName || 'Seamo AI'" @close="closePanels" />
    <R1FocusDialog v-if="focusEditorOpen" :active="focus.active.value" :busy="focus.busy.value"
      :error="focus.error.value" :track="focusTargetTrack" @close="focusEditorOpen = false" @start="startFocus" />
    <aside v-if="!reminderNotice && (focusNotice || (focus.error.value && !focusEditorOpen))" class="r1-reminder-toast" role="status">
      <p>{{ focusNotice || focus.error.value }}</p><button type="button" @click="focusNotice = ''; focus.error.value = ''">关闭</button>
    </aside>
    <aside v-if="reminderNotice" class="r1-reminder-toast" role="status">
      <div><strong>{{ reminderNotice.recoveredCount ? '错过的提醒' : reminderNotice.kind === 'followup' ? '约定的回访时间到了' : '提醒已到期' }}</strong><p>{{ reminderNotice.body }}</p>
        <p v-if="reminderNotice.kind === 'followup'">现在方便接着聊这件事吗？</p>
        <small>{{ reminderNotice.systemRequested ? '系统通知已请求；不代表已读。' : '已在应用内显示；系统通知未请求。' }}</small>
      </div>
      <button type="button" @click="openPanel('items'); reminderNotice = null">查看事项</button>
      <button type="button" @click="reminderNotice = null">关闭</button>
    </aside>
    <R1TaskCompletionNotice v-if="!welcomeOpen && !reminderNotice && !focusNotice && !focus.error.value && latestTaskCompletion"
      :notice="latestTaskCompletion" :count="taskState.completionNotices.value.length"
      @view="viewTaskCompletion" @dismiss="taskState.dismissCompletion(latestTaskCompletion.key)" />
    <aside v-if="!welcomeOpen && !temporaryMode && !reminderNotice && !focusNotice && !latestTaskCompletion && taskState.recoveryTasks.value.length" class="r1-reminder-toast" role="status">
      <div><strong>上次还有 {{ taskState.recoveryTasks.value.length }} 项委托未完成</strong><p>尚未重新执行。选择继续后，会先核对已保存的结果。</p></div>
      <button type="button" @click="async () => { if (await openTask(taskState.recoveryTasks.value[0]!.taskId)) taskState.dismissRecovery() }">查看委托</button>
      <button type="button" @click="taskState.dismissRecovery()">稍后</button>
    </aside>
  </main>
</template>
