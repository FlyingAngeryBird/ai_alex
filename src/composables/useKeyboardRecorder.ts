import { ref } from 'vue'
import type { AppResult, LingliChannel } from '@/types/electron-api'
import { invokeWithTimeout } from '../utils/invokeWithTimeout'
import { acquireAudioInput, withCaptureAbort } from '../services/abortableCapture'
import { monitorMicrophoneActivity } from '../services/microphoneActivity'

type TranscriptionResult = {
  text: string
}

type LingliApi = {
  invoke<T>(channel: LingliChannel, payload?: unknown): Promise<AppResult<T>>
}

type KeyboardRecorderOptions = {
  createMediaRecorder?: (stream: MediaStream) => MediaRecorder
  lingli?: LingliApi
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>
  inputConstraints?: () => MediaTrackConstraints
  onDeviceLost?: () => void
}

function getLingliApi(options: KeyboardRecorderOptions): LingliApi {
  const api = options.lingli ?? globalThis.window?.lingli

  if (!api) {
    throw new Error('语音通道不可用')
  }

  return api
}

function getMediaDevices(options: KeyboardRecorderOptions): Pick<MediaDevices, 'getUserMedia'> {
  const mediaDevices = options.mediaDevices ?? globalThis.navigator?.mediaDevices

  if (!mediaDevices?.getUserMedia) {
    throw new Error('当前环境无法访问麦克风')
  }

  return mediaDevices
}

export function useKeyboardRecorder(options: KeyboardRecorderOptions = {}) {
  const errorMessage = ref('')
  const isRecording = ref(false)
  const userSpeaking = ref(false)

  let chunks: Blob[] = []
  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null
  let abortCapture: AbortController | null = null, generation = 0, starting = false
  let stopActivity: (() => void) | null = null
  const trackListeners: Array<() => void> = []
  function releaseCapture(): void {
    stopActivity?.(); stopActivity = null; userSpeaking.value = false
    trackListeners.splice(0).forEach(remove => remove())
    stream?.getTracks().forEach(track => track.stop()); stream = null
  }

  function cleanup(): void {
    releaseCapture()
    recorder = null
    chunks = []
    isRecording.value = false
  }

  async function start(signal?: AbortSignal): Promise<void> {
    if (isRecording.value || starting) {
      return
    }

    errorMessage.value = ''
    starting = true; const epoch = ++generation
    abortCapture = new AbortController()
    const captureSignal = signal ? AbortSignal.any([signal, abortCapture.signal]) : abortCapture.signal
    try {
      getLingliApi(options)
      const mediaDevices = getMediaDevices(options)
      stream = await acquireAudioInput(mediaDevices, options.inputConstraints?.() ?? true, captureSignal)
      if (epoch !== generation) throw new Error('VOICE_CAPTURE_CANCELLED')
      for (const track of stream.getTracks()) {
        const ended = () => { if (epoch === generation) { cancel(); options.onDeviceLost?.() } }
        track.addEventListener?.('ended', ended); trackListeners.push(() => track.removeEventListener?.('ended', ended))
      }
      stopActivity = monitorMicrophoneActivity(stream, active => { userSpeaking.value = active })
      recorder = options.createMediaRecorder?.(stream) ?? new MediaRecorder(stream)
      chunks = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data)
        }
      }

      recorder.start()
      isRecording.value = true
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '语音输入没有启动成功'
      cleanup()
      throw error
    } finally { starting = false }
  }

  async function stopAndTranscribe(): Promise<TranscriptionResult> {
    if (!recorder || !isRecording.value) {
      throw new Error('当前没有正在录制的语音')
    }

    const activeRecorder = recorder
    const epoch = generation

    const stopped = await invokeWithTimeout<Blob>(new Promise<Blob>((resolve) => {
      activeRecorder.onstop = () => {
        resolve(new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' }))
      }
      activeRecorder.stop()
    }).then(blob => ({ ok: true as const, data: blob })), 6000, '录音结束超时。').finally(() => { releaseCapture(); isRecording.value = false })
    if (!stopped.ok) throw new Error(stopped.error.message)
    const audioBlob = stopped.data
    if (epoch !== generation) throw new Error('VOICE_CAPTURE_CANCELLED')

    let response: AppResult<TranscriptionResult>

    try {
      const audio = await audioBlob.arrayBuffer()
      if (epoch !== generation || abortCapture?.signal.aborted) throw new Error('VOICE_CAPTURE_CANCELLED')
      response = await withCaptureAbort(invokeWithTimeout(
        getLingliApi(options).invoke<TranscriptionResult>('voice.stopAndTranscribe', {
          audio,
          mimeType: audioBlob.type
        }),
        15000,
        '语音识别响应超时。'
      ), abortCapture?.signal)
      if (epoch !== generation) throw new Error('VOICE_CAPTURE_CANCELLED')
    } finally {
      cleanup()
    }

    if (!response.ok) {
      errorMessage.value = response.error.message
      throw new Error(response.error.message)
    }

    return response.data
  }

  function cancel(): void {
    generation++; abortCapture?.abort()
    try {
      if (recorder && recorder.state !== 'inactive') {
        recorder.ondataavailable = null
        recorder.onstop = null
        recorder.stop()
      }
    } finally { cleanup() }
  }

  return {
    errorMessage,
    isRecording,
    userSpeaking,
    cancel,
    start,
    stopAndTranscribe
  }
}
