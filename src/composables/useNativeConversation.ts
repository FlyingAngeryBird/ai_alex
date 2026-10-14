import { ref } from 'vue'
import type { NativeRealtimeEvent } from '../../electron/main/providers/nativeRealtimeSession'

/** One capture stream and one PCM playback queue for a native duplex connection. */
export function useNativeConversation(options: {
  onText(event: NativeRealtimeEvent): void; onError(message: string): void;
  onSpeaking(speaking: boolean): void;
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
    if (stopping) return stopping
    stopping = stopNow().finally(() => { stopping = null })
    return stopping
  }
  async function stopNow(): Promise<void> {
    closing = true
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
    if (active.value || starting.value || stopping) return false
    starting.value = true
    const epoch = ++generation, id = crypto.randomUUID()
    connectionId = id
    const matches = () => generation === epoch && connectionId === id
    const current = () => matches() && !closing
    try {
      const permission = await window.lingli.invoke<{ granted: boolean }>('app.requestMicrophoneAccess')
      if (!current()) return false
      if (!permission.ok || !permission.data.granted) throw new Error('请在系统设置中允许麦克风访问。')
      const captured = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true
      } })
      if (!current()) { captured.getTracks().forEach(track => track.stop()); return false }
      stream = captured
      context = new AudioContext(); await context.resume()
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
            void stop(); options.onError(`连续语音已结束（${code}）。`); return
          }
          if (event.type === 'conversation.item.input_audio_transcription.started') userSpeaking.value = true
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
      if (!result.ok) throw new Error(`原生语音未连接（${result.error.code}），请检查设置中的实时对话配置。`)
      source = context.createMediaStreamSource(stream)
      source.connect(processor)
      const unmuted = await window.lingli.invoke('voice.nativeMute', { connectionId: id, muted: false })
      if (!current()) return false
      if (!unmuted.ok) throw new Error('语音收音未能启动。')
      active.value = true; starting.value = false
      processor.port.postMessage({ type: 'capture', enabled: true })
      stream.getTracks().forEach(track => track.addEventListener('ended', () => {
        if (current()) { void stop(); options.onError('麦克风已断开。') }
      }))
      return true
    } catch (error) {
      if (current()) { await stop(); options.onError(error instanceof Error ? error.message : '连续语音未能启动。') }
      return false
    }
  }
  return { active, starting, speaking, userSpeaking, start, stop, interrupt }
}
