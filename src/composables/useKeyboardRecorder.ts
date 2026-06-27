import { ref } from 'vue'
import type { AppResult, LingliChannel } from '@/types/electron-api'

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

  let chunks: Blob[] = []
  let recorder: MediaRecorder | null = null
  let stream: MediaStream | null = null

  function cleanup(): void {
    stream?.getTracks().forEach((track) => track.stop())
    stream = null
    recorder = null
    chunks = []
    isRecording.value = false
  }

  async function start(): Promise<void> {
    if (isRecording.value) {
      return
    }

    errorMessage.value = ''
    const mediaDevices = getMediaDevices(options)
    stream = await mediaDevices.getUserMedia({ audio: true })
    recorder = options.createMediaRecorder?.(stream) ?? new MediaRecorder(stream)
    chunks = []

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data)
      }
    }

    recorder.start()
    isRecording.value = true
  }

  async function stopAndTranscribe(): Promise<TranscriptionResult> {
    if (!recorder || !isRecording.value) {
      throw new Error('当前没有正在录制的语音')
    }

    const activeRecorder = recorder

    const audioBlob = await new Promise<Blob>((resolve) => {
      activeRecorder.onstop = () => {
        resolve(new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' }))
      }
      activeRecorder.stop()
    })

    const audio = await audioBlob.arrayBuffer()
    const response = await getLingliApi(options).invoke<TranscriptionResult>('voice.stopAndTranscribe', {
      audio,
      mimeType: audioBlob.type
    })

    cleanup()

    if (!response.ok) {
      errorMessage.value = response.error.message
      throw new Error(response.error.message)
    }

    return response.data
  }

  return {
    errorMessage,
    isRecording,
    start,
    stopAndTranscribe
  }
}
