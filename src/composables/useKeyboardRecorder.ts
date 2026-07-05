import { ref } from 'vue'
import type { AppResult, LingliChannel } from '@/types/electron-api'
import { invokeWithTimeout } from '../utils/invokeWithTimeout'

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
    try {
      getLingliApi(options)
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
    } catch (error) {
      errorMessage.value = error instanceof Error ? error.message : '语音输入没有启动成功'
      cleanup()
      throw error
    }
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

    let response: AppResult<TranscriptionResult>

    try {
      const audio = await audioBlob.arrayBuffer()
      response = await invokeWithTimeout(
        getLingliApi(options).invoke<TranscriptionResult>('voice.stopAndTranscribe', {
          audio,
          mimeType: audioBlob.type
        }),
        15000,
        '语音识别响应超时。'
      )
    } finally {
      cleanup()
    }

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
