import { ref } from 'vue'
import type { AppResult, LingliChannel } from '@/types/electron-api'
import { invokeWithTimeout } from '../utils/invokeWithTimeout'

type RealtimeStartResult = {
  sessionId: string
}

type RealtimeStopResult = {
  text: string
}

type LingliApi = {
  invoke<T>(channel: LingliChannel, payload?: unknown): Promise<AppResult<T>>
}

type RealtimeVoiceRecorderOptions = {
  createAudioContext?: () => AudioContext
  lingli?: LingliApi
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>
  onPartialText?: (text: string) => void
}

type RealtimeVoiceStartOptions = {
  initialAudio?: ArrayBuffer
  stream?: MediaStream
}

const TARGET_SAMPLE_RATE = 16000
const CHUNK_SAMPLES = 3200

function getLingliApi(options: RealtimeVoiceRecorderOptions): LingliApi {
  const api = options.lingli ?? globalThis.window?.lingli

  if (!api) {
    throw new Error('实时语音通道不可用')
  }

  return api
}

function getMediaDevices(options: RealtimeVoiceRecorderOptions): Pick<MediaDevices, 'getUserMedia'> {
  const mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices

  if (!mediaDevices?.getUserMedia) {
    throw new Error('当前环境无法访问麦克风')
  }

  return mediaDevices
}

function createAudioContext(options: RealtimeVoiceRecorderOptions): AudioContext {
  if (options.createAudioContext) {
    return options.createAudioContext()
  }

  const browserGlobal = globalThis as typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
  }
  const AudioContextCtor = browserGlobal.AudioContext ?? browserGlobal.webkitAudioContext

  if (!AudioContextCtor) {
    throw new Error('当前环境无法创建音频上下文')
  }

  return new AudioContextCtor()
}

function downsampleToPcm16(samples: Float32Array, inputSampleRate: number): Int16Array {
  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    return floatToPcm16(samples)
  }

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE
  const outputLength = Math.floor(samples.length / ratio)
  const output = new Float32Array(outputLength)

  for (let index = 0; index < outputLength; index += 1) {
    output[index] = samples[Math.floor(index * ratio)] ?? 0
  }

  return floatToPcm16(output)
}

function floatToPcm16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length)

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }

  return output
}

function concatPcm(a: Int16Array, b: Int16Array): Int16Array {
  const output = new Int16Array(a.length + b.length)

  output.set(a, 0)
  output.set(b, a.length)
  return output
}

function int16ToArrayBuffer(samples: Int16Array<ArrayBufferLike>): ArrayBuffer {
  return Uint8Array.from(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)).buffer
}

export function useRealtimeVoiceRecorder(options: RealtimeVoiceRecorderOptions = {}) {
  const errorMessage = ref('')
  const isRecording = ref(false)

  let audioContext: AudioContext | null = null
  let pending: Int16Array<ArrayBufferLike> = new Int16Array(0)
  let processor: ScriptProcessorNode | null = null
  let pushQueue = Promise.resolve()
  let sessionId = ''
  let ownsStream = false
  let source: MediaStreamAudioSourceNode | null = null
  let stream: MediaStream | null = null

  function cleanup(): void {
    processor?.disconnect()
    source?.disconnect()
    if (ownsStream) {
      stream?.getTracks().forEach((track) => track.stop())
    }
    void audioContext?.close()

    audioContext = null
    ownsStream = false
    pending = new Int16Array(0)
    processor = null
    pushQueue = Promise.resolve()
    sessionId = ''
    source = null
    stream = null
    isRecording.value = false
    options.onPartialText?.('')
  }

  async function sendChunk(audio: ArrayBuffer): Promise<void> {
    if (!sessionId) {
      return
    }
    const activeSessionId = sessionId

    const response = await invokeWithTimeout(
      getLingliApi(options).invoke<{ partialText?: string }>('voice.pushRealtimeAudio', {
        audio,
        sessionId: activeSessionId
      }),
      10000,
      '实时语音识别响应超时。'
    )

    if (sessionId !== activeSessionId) return
    if (!response.ok) {
      errorMessage.value = response.error.message
      return
    }

    const partialText = response.data?.partialText

    if (partialText) {
      options.onPartialText?.(partialText)
    }
  }

  async function closeRealtimeSession(activeSessionId: string): Promise<void> {
    if (!activeSessionId) {
      return
    }

    try {
      await invokeWithTimeout(getLingliApi(options).invoke('voice.stopRealtime', {
        sessionId: activeSessionId
      }), 6000, '实时语音清理超时。')
    } catch {
      // This is a best-effort remote cleanup. The original local failure is more useful to the user.
    }
  }

  function queueAvailableChunks(): void {
    while (pending.length >= CHUNK_SAMPLES) {
      const chunk = pending.slice(0, CHUNK_SAMPLES)
      pending = pending.slice(CHUNK_SAMPLES)
      pushQueue = pushQueue.then(() => sendChunk(int16ToArrayBuffer(chunk)))
    }
  }

  async function flush(): Promise<void> {
    if (pending.length > 0) {
      const chunk = pending
      pending = new Int16Array(0)
      pushQueue = pushQueue.then(() => sendChunk(int16ToArrayBuffer(chunk)))
    }

    await pushQueue
  }

  async function start(startOptions: RealtimeVoiceStartOptions = {}): Promise<void> {
    if (isRecording.value) {
      return
    }

    errorMessage.value = ''
    let startedSessionId = ''

    try {
      const mediaDevices = getMediaDevices(options)
      const api = getLingliApi(options)

      stream = startOptions.stream ?? await mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true
        }
      })
      ownsStream = !startOptions.stream
      audioContext = createAudioContext(options)

      const startResult = await invokeWithTimeout(
        api.invoke<RealtimeStartResult>('voice.startRealtime', {
          sampleRate: TARGET_SAMPLE_RATE
        }),
        15000,
        '实时语音识别启动超时。'
      )

      if (!startResult.ok) {
        errorMessage.value = startResult.error.message
        throw new Error(startResult.error.message)
      }

      sessionId = startResult.data.sessionId
      startedSessionId = sessionId
      if (startOptions.initialAudio && startOptions.initialAudio.byteLength > 0) {
        pushQueue = pushQueue.then(() => sendChunk(startOptions.initialAudio as ArrayBuffer))
      }
      source = audioContext.createMediaStreamSource(stream)
      processor = audioContext.createScriptProcessor(4096, 1, 1)
      processor.onaudioprocess = (event) => {
        if (!audioContext || !isRecording.value) {
          return
        }

        const samples = event.inputBuffer.getChannelData(0)
        pending = concatPcm(pending, downsampleToPcm16(samples, audioContext.sampleRate))
        queueAvailableChunks()
      }

      source.connect(processor)
      processor.connect(audioContext.destination)
      isRecording.value = true
    } catch (error) {
      if (startedSessionId) {
        await closeRealtimeSession(startedSessionId)
      }
      cleanup()
      throw error
    }
  }

  async function stopAndTranscribe(): Promise<RealtimeStopResult> {
    if (!isRecording.value || !sessionId) {
      throw new Error('当前没有正在实时识别的语音')
    }

    const activeSessionId = sessionId

    let response: AppResult<RealtimeStopResult>
    let stopRequested = false

    try {
      await flush()
      stopRequested = true
      response = await invokeWithTimeout(
        getLingliApi(options).invoke<RealtimeStopResult>('voice.stopRealtime', {
          sessionId: activeSessionId
        }),
        15000,
        '实时语音识别停止超时。'
      )
    } catch (error) {
      if (!stopRequested) {
        await closeRealtimeSession(activeSessionId)
      }
      throw error
    } finally {
      cleanup()
    }

    if (!response.ok) {
      errorMessage.value = response.error.message
      throw new Error(response.error.message)
    }

    return response.data
  }

  async function cancel(): Promise<void> {
    const activeSessionId = sessionId
    cleanup()
    await closeRealtimeSession(activeSessionId)
  }

  return {
    errorMessage,
    flush,
    isRecording,
    cancel,
    start,
    stopAndTranscribe
  }
}
