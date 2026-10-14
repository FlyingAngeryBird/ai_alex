import { ref } from 'vue'
import type { NativeRealtimeEvent } from '../../electron/main/providers/nativeRealtimeSession'

/** One capture stream and one PCM playback queue for a native duplex connection. */
export function useNativeConversation(options: {
  onText(event: NativeRealtimeEvent): void; onError(message: string): void;
  onSpeaking(speaking: boolean): void;
}) {
  const active = ref(false), starting = ref(false), speaking = ref(false)
  let generation = 0, connectionId: string | null = null
  let context: AudioContext | null = null, stream: MediaStream | null = null
  let processor: ScriptProcessorNode | null = null, source: MediaStreamAudioSourceNode | null = null
  let silent: GainNode | null = null, unsubscribe: (() => void) | null = null
  let nextStart = 0, responseId: string | null = null, inflight = 0
  const nodes = new Set<AudioBufferSourceNode>(), cancelled = new Set<string>()
  const setSpeaking = (value: boolean) => { speaking.value = value; options.onSpeaking(value) }
  function clearPlayback(): void {
    for (const node of nodes) { node.onended = null; node.stop(); node.disconnect() }
    nodes.clear(); nextStart = 0; setSpeaking(false)
  }
  function play(event: NativeRealtimeEvent): void {
    if (!context || typeof event.response_id !== 'string' || typeof event.delta !== 'string' || cancelled.has(event.response_id)) return
    if (responseId && responseId !== event.response_id) clearPlayback()
    responseId = event.response_id
    const bytes = atob(event.delta)
    if (!bytes.length || bytes.length % 2 || bytes.length > 1_048_576) throw new Error('音频数据格式不正确。')
    if (nextStart - context.currentTime > 30) throw new Error('语音播放积压，请重新开启会话。')
    const buffer = context.createBuffer(1, bytes.length / 2, 24000), samples = buffer.getChannelData(0)
    for (let i = 0; i < samples.length; i++) {
      const value = bytes.charCodeAt(i * 2) | (bytes.charCodeAt(i * 2 + 1) << 8)
      samples[i] = (value >= 32768 ? value - 65536 : value) / 32768
    }
    const node = context.createBufferSource(); node.buffer = buffer; node.connect(context.destination)
    const at = Math.max(nextStart, context.currentTime + 0.01)
    nextStart = at + buffer.duration; nodes.add(node)
    node.onended = () => { nodes.delete(node); node.disconnect(); if (!nodes.size) setSpeaking(false) }
    node.start(at); setSpeaking(true)
  }
  async function stop(): Promise<void> {
    generation++; active.value = false; starting.value = false
    const id = connectionId; connectionId = null
    unsubscribe?.(); unsubscribe = null
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); processor = null }
    source?.disconnect(); source = null; silent?.disconnect(); silent = null
    stream?.getTracks().forEach(track => track.stop()); stream = null
    clearPlayback(); cancelled.clear(); responseId = null
    const old = context; context = null; if (old) void old.close()
    if (id) await window.lingli.invoke('voice.nativeStop', { connectionId: id }).catch(() => undefined)
  }
  async function interrupt(): Promise<void> {
    if (responseId) cancelled.add(responseId)
    clearPlayback()
    if (connectionId) await window.lingli.invoke('voice.nativeCancel', { connectionId })
  }
  async function start(): Promise<boolean> {
    if (active.value || starting.value) return false
    starting.value = true
    const epoch = ++generation, id = crypto.randomUUID()
    connectionId = id
    const current = () => generation === epoch && connectionId === id
    try {
      const permission = await window.lingli.invoke<{ granted: boolean }>('app.requestMicrophoneAccess')
      if (!current()) return false
      if (!permission.ok || !permission.data.granted) throw new Error('请在系统设置中允许麦克风访问。')
      const captured = await navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true
      } })
      if (!current()) { captured.getTracks().forEach(track => track.stop()); return false }
      stream = captured
      context = new AudioContext({ sampleRate: 16000 }); await context.resume()
      if (!current()) return false
      unsubscribe = window.lingli.on<NativeRealtimeEvent>('voice.nativeEvent', event => {
        if (!current() || event.connectionId !== id) return
        try {
          if (event.type === 'closed') {
            const code = String(event.code)
            void stop(); options.onError(`连续语音已结束（${code}）。`); return
          }
          if (event.type === 'conversation.item.input_audio_transcription.started' || event.type === 'response.canceled') {
            if (responseId) cancelled.add(responseId)
            clearPlayback()
          }
          if (event.type === 'response.output_audio.delta') play(event)
          options.onText(event)
        } catch (error) { void stop(); options.onError(error instanceof Error ? error.message : '语音播放失败。') }
      })
      const result = await window.lingli.invoke('voice.nativeStart', { connectionId: id })
      if (!current()) return false
      if (!result.ok) throw new Error(`原生语音未连接（${result.error.code}），请检查设置中的实时对话配置。`)
      source = context.createMediaStreamSource(stream)
      processor = context.createScriptProcessor(1024, 1, 1)
      silent = context.createGain(); silent.gain.value = 0
      const captureRate = context.sampleRate
      let carry: number[] = [], cursor = 0
      processor.onaudioprocess = event => {
        if (!current() || !active.value) return
        // Carry fractional position between callbacks; never reset the resampling clock per chunk.
        carry.push(...event.inputBuffer.getChannelData(0))
        const ratio = captureRate / 16000, output: number[] = []
        while (cursor + 1 < carry.length) {
          const left = Math.floor(cursor), fraction = cursor - left
          const value = Math.max(-1, Math.min(1, carry[left] * (1 - fraction) + carry[left + 1] * fraction))
          output.push(Math.round(value * (value < 0 ? 32768 : 32767))); cursor += ratio
        }
        const consumed = Math.floor(cursor); carry = carry.slice(consumed); cursor -= consumed
        if (!output.length) return
        if (inflight >= 4) { void stop(); options.onError('语音传输拥塞，已停止收音，请重新开启。'); return }
        const pcm = new Uint8Array(output.length * 2), view = new DataView(pcm.buffer)
        output.forEach((value, index) => view.setInt16(index * 2, value, true))
        inflight++
        void window.lingli.invoke('voice.nativeAudio', { connectionId: id, pcm }).then(result => {
          if (current() && !result.ok) { void stop(); options.onError('语音连接中断，请重新开启。') }
        }).catch(() => { if (current()) { void stop(); options.onError('语音连接中断，请重新开启。') } })
          .finally(() => { inflight-- })
      }
      source.connect(processor); processor.connect(silent); silent.connect(context.destination)
      const unmuted = await window.lingli.invoke('voice.nativeMute', { connectionId: id, muted: false })
      if (!current()) return false
      if (!unmuted.ok) throw new Error('语音收音未能启动。')
      active.value = true; starting.value = false
      stream.getTracks().forEach(track => track.addEventListener('ended', () => {
        if (current()) { void stop(); options.onError('麦克风已断开。') }
      }))
      return true
    } catch (error) {
      if (current()) { await stop(); options.onError(error instanceof Error ? error.message : '连续语音未能启动。') }
      return false
    }
  }
  return { active, starting, speaking, start, stop, interrupt }
}
