import { ref } from 'vue'
import type { NativeRealtimeEvent } from '../../electron/main/providers/nativeRealtimeSession'
import runtimeDefaults from '../../r1-assets/config/runtime.defaults.json'

const needsContextRefresh = (code: string) => ['MEMORY_CONTEXT_REFRESH_REQUIRED', 'REALTIME_CONTEXT_REFRESH_REQUIRED'].includes(code)
const retryableConnectionFailure = (code: string) => ['REALTIME_NETWORK_FAILED', 'REALTIME_CONNECTION_CLOSED',
  'REALTIME_START_TIMEOUT', 'REALTIME_UPGRADE_FAILED'].includes(code)
function connectionMessage(code: string): string {
  if (/[\u3400-\u9fff]/.test(code)) return code
  if (code === 'REALTIME_AUTH_FAILED') return '实时对话鉴权失败，请检查设置中的服务凭据。'
  if (code === 'REALTIME_QUOTA_LIMIT') return '实时对话服务额度不足，请检查服务额度后重新开启。'
  if (needsContextRefresh(code)) return '对话上下文刷新未完成，请重新开启连续语音。'
  if (retryableConnectionFailure(code)) return '语音连接中断，自动重连未成功。请检查网络后重新开启。'
  if (code === 'REALTIME_STOPPED') return '连续语音已结束。'
  return '连续语音未能连接，请检查麦克风和设置中的实时对话配置。'
}

/** One capture stream and one PCM playback queue for a native duplex connection. */
export function useNativeConversation(options: {
  onText(event: NativeRealtimeEvent): void; onError(message: string): void;
  onSpeaking(speaking: boolean): void;
  onConnectionState?(state: 'rebuilding' | 'ready'): void;
  inputConstraints?: () => MediaTrackConstraints;
  configureOutput?: (context: AudioContext) => Promise<() => void>;
}) {
  const userSpeaking = ref(false)
  const active = ref(false), starting = ref(false), speaking = ref(false)
  let generation = 0, connectionId: string | null = null
  let context: AudioContext | null = null, stream: MediaStream | null = null
  let processor: AudioWorkletNode | null = null, source: MediaStreamAudioSourceNode | null = null
  let unsubscribe: (() => void) | null = null
  let responseId: string | null = null, inflight = 0
  const cancelled = new Set<string>()
  const clearWaiters = new Map<string, () => void>()
  let stopping: Promise<void> | null = null
  let closing = false
  let wanted = false, intent = 0, networkRetries = 0
  let recovery: Promise<void> | null = null
  let releaseOutput: (() => void) | null = null
  let queuedRecovery: string | null = null
  const setSpeaking = (value: boolean) => { speaking.value = value; options.onSpeaking(value) }
  function clearPlayback(): Promise<void> {
    setSpeaking(false)
    if (!processor) return Promise.resolve()
    const requestId = crypto.randomUUID()
    return new Promise(resolve => {
      const timeout = setTimeout(() => { clearWaiters.delete(requestId); resolve() }, 250)
      clearWaiters.set(requestId, () => { clearTimeout(timeout); clearWaiters.delete(requestId); resolve() })
      processor!.port.postMessage({ type: 'clear', requestId })
    })
  }
  function play(event: NativeRealtimeEvent): void {
    if (!processor || typeof event.response_id !== 'string' || typeof event.delta !== 'string' || cancelled.has(event.response_id)) return
    responseId = event.response_id
    const bytes = atob(event.delta)
    if (!bytes.length || bytes.length % 2 || bytes.length > 1_048_576) throw new Error('音频数据格式不正确。')
    const pcm = Uint8Array.from(bytes, byte => byte.charCodeAt(0))
    processor.port.postMessage({ type: 'audio', responseId, pcm }, [pcm.buffer])
  }
  function stop(): Promise<void> {
    wanted = false; intent++; queuedRecovery = null
    return stopResources()
  }
  function stopResources(): Promise<void> {
    if (stopping) return stopping
    stopping = stopNow().finally(() => { stopping = null })
    return stopping
  }
  async function stopNow(): Promise<void> {
    closing = true
    userSpeaking.value = false
    active.value = false
    processor?.port.postMessage({ type: 'capture', enabled: false })
    await clearPlayback()
    generation++; userSpeaking.value = false; active.value = false; starting.value = false
    const id = connectionId; connectionId = null
    unsubscribe?.(); unsubscribe = null
    if (processor) { processor.port.close(); processor.disconnect(); processor = null }
    source?.disconnect(); source = null
    stream?.getTracks().forEach(track => track.stop()); stream = null
    setSpeaking(false); cancelled.clear(); responseId = null
    releaseOutput?.(); releaseOutput = null
    const old = context; context = null; if (old) void old.close()
    if (id) await window.lingli.invoke('voice.nativeStop', { connectionId: id }).catch(() => undefined)
    closing = false
  }
  async function interrupt(): Promise<void> {
    if (responseId) cancelled.add(responseId)
    await clearPlayback()
    if (connectionId) await window.lingli.invoke('voice.nativeCancel', { connectionId })
  }
  async function start(): Promise<boolean> {
    if (active.value || starting.value || stopping || recovery) return false
    wanted = true; networkRetries = 0
    const request = ++intent
    try { return await openConnection(request) }
    catch (error) {
      if (wanted && intent === request) {
        const code = error instanceof Error ? error.message : 'REALTIME_START_FAILED'
        if (needsContextRefresh(code) || retryableConnectionFailure(code)) {
          await recover(code)
          return active.value && wanted && intent === request
        }
        wanted = false
        options.onError(connectionMessage(code))
      }
      return false
    }
  }
  async function recover(code: string): Promise<void> {
    if (!wanted) return
    if (recovery) { queuedRecovery = code; return }
    const request = intent
    const stillWanted = () => wanted && intent === request
    // Invalidation closes the old cloud session before this event. Stop capture and
    // clear the device queue before a new connection may accept any microphone data.
    active.value = false
    processor?.port.postMessage({ type: 'capture', enabled: false })
    options.onConnectionState?.('rebuilding')
    recovery = (async () => {
      let reason = code, refreshes = 0
      while (stillWanted()) {
        if (needsContextRefresh(reason)) {
          if (++refreshes > 2) break
        } else if (!retryableConnectionFailure(reason) || networkRetries++ >= runtimeDefaults.limits.autoReconnectAttempts) break
        await stopResources()
        if (!stillWanted()) return
        if (!needsContextRefresh(reason)) await new Promise(resolve => setTimeout(resolve, 250 * networkRetries))
        if (!stillWanted()) return
        try { if (await openConnection(request)) return; else return }
        catch (error) { reason = error instanceof Error ? error.message : 'REALTIME_START_FAILED' }
      }
      if (!stillWanted()) return
      wanted = false
      await stopResources()
      options.onError(connectionMessage(reason))
    })().finally(() => {
      recovery = null
      const queued = queuedRecovery; queuedRecovery = null
      if (wanted && queued) void recover(queued)
    })
    await recovery
  }
  async function openConnection(request: number): Promise<boolean> {
    if (!wanted || intent !== request) return false
    starting.value = true
    const epoch = ++generation, id = crypto.randomUUID()
    let closedWhileStarting: string | null = null
    connectionId = id
    const matches = () => generation === epoch && connectionId === id
    const current = () => matches() && !closing && wanted && intent === request
    try {
      const permission = await window.lingli.invoke<{ granted: boolean }>('app.requestMicrophoneAccess')
      if (!current()) return false
      if (!permission.ok || !permission.data.granted) throw new Error('请在系统设置中允许麦克风访问。')
      const captured = await navigator.mediaDevices.getUserMedia({ audio: options.inputConstraints?.() ?? {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true
      } })
      if (!current()) { captured.getTracks().forEach(track => track.stop()); return false }
      stream = captured
      for (const track of captured.getTracks()) track.addEventListener?.('ended', () => {
        if (current()) { options.onError('麦克风已断开。请在设置中选择可用设备后重新开启；文字仍可使用。'); void stop() }
      }, { once: true })
      context = new AudioContext()
      if (options.configureOutput) {
        const release = await options.configureOutput(context)
        if (!current()) { release(); return false }
        releaseOutput = release
      }
      await context.resume()
      if (!current()) return false
      await context.audioWorklet.addModule(new URL('native-duplex-worklet.js', document.baseURI).href)
      if (!current()) return false
      processor = new AudioWorkletNode(context, 'seamo-native-duplex', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      processor.connect(context.destination)
      processor.port.onmessage = ({ data }) => {
        if (data.type === 'cleared') { clearWaiters.get(data.requestId)?.(); return }
        if (!matches()) return
        if (data.type === 'playback') {
          setSpeaking(!closing && (data.status === 'started' || data.status === 'playing'))
          void window.lingli.invoke('voice.nativePlayback', { connectionId: id, ...data }).catch(() => undefined)
        } else if (data.type === 'error') { void stop(); options.onError('语音播放缓冲已满，请重新开启。') }
        else if (data.type === 'capture' && current() && active.value) {
          if (inflight >= 4) { void stop(); options.onError('语音传输拥塞，已停止收音。'); return }
          inflight++
          void window.lingli.invoke('voice.nativeAudio', { connectionId: id, pcm: data.pcm }).then(result => {
            if (current() && !result.ok) { void stop(); options.onError('语音连接中断，请重新开启。') }
          }).catch(() => { if (current()) { void stop(); options.onError('语音连接中断，请重新开启。') } })
            .finally(() => { inflight-- })
        }
      }
      unsubscribe = window.lingli.on<NativeRealtimeEvent>('voice.nativeEvent', event => {
        if (!current() || event.connectionId !== id) return
        try {
          if (event.type === 'closed') {
            const code = String(event.code)
            if (starting.value) { closedWhileStarting = code; return }
            if (needsContextRefresh(code) || retryableConnectionFailure(code)) void recover(code)
            else { void stop(); options.onError(connectionMessage(code)) }
            return
          }
          if (event.type === 'conversation.item.input_audio_transcription.started') userSpeaking.value = true
          if (event.type === 'conversation.item.input_audio_transcription.completed') networkRetries = 0
          if (event.type === 'conversation.item.input_audio_transcription.completed' || event.type === 'conversation.item.input_audio_transcription.failed') userSpeaking.value = false
          if (event.type === 'conversation.item.input_audio_transcription.started' || event.type === 'response.canceled' && (!event.response_id || event.response_id === responseId)) {
            if (responseId) cancelled.add(responseId)
            void clearPlayback()
          }
          if (event.type === 'response.output_audio.delta') play(event)
          if (event.type === 'response.output_audio.done') processor?.port.postMessage({ type: 'done', responseId: event.response_id })
          options.onText(event)
        } catch (error) { void stop(); options.onError(error instanceof Error ? error.message : '语音播放失败。') }
      })
      const result = await window.lingli.invoke('voice.nativeStart', { connectionId: id })
      if (!current()) return false
      if (closedWhileStarting) throw new Error(closedWhileStarting)
      if (!result.ok) throw new Error(result.error.code)
      source = context.createMediaStreamSource(stream)
      source.connect(processor)
      const unmuted = await window.lingli.invoke('voice.nativeMute', { connectionId: id, muted: false })
      if (!current()) return false
      if (closedWhileStarting) throw new Error(closedWhileStarting)
      if (!unmuted.ok) throw new Error('语音收音未能启动。')
      active.value = true; starting.value = false
      options.onConnectionState?.('ready')
      processor.port.postMessage({ type: 'capture', enabled: true })
      stream.getTracks().forEach(track => track.addEventListener('ended', () => {
        if (current()) { void stop(); options.onError('麦克风已断开。') }
      }))
      return true
    } catch (error) {
      if (current()) { await stopResources(); throw error }
      return false
    }
  }
  return { active, starting, speaking, userSpeaking, start, stop, interrupt }
}
