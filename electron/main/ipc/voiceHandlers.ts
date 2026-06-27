import { createRequire } from 'node:module'
import { createVolcengineAsrProvider, VolcengineAsrError } from '../providers/asrProvider.js'
import {
  createUnavailableStreamingAsrProvider,
  RealtimeVoiceError,
  type RealtimeAsrPushPayload,
  type RealtimeAsrStartPayload,
  type RealtimeAsrStopPayload,
  type StreamingAsrProvider
} from '../providers/realtimeVoiceProvider.js'

type AppResult<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: {
        code: string
        message: string
      }
    }

export type AudioTranscriptionPayload = {
  audio: ArrayBuffer
  mimeType: string
}

export type AudioTranscriptionResult = {
  text: string
}

export type AsrProvider = {
  transcribe(payload: AudioTranscriptionPayload): Promise<AudioTranscriptionResult>
}

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
}

type ElectronRuntime = {
  ipcMain: IpcMainLike
}

const require = createRequire(import.meta.url)

export const mockAsrProvider: AsrProvider = {
  async transcribe() {
    return {
      text: '我刚刚开口说话了'
    }
  }
}

function ok<T>(data: T): AppResult<T> {
  return {
    ok: true,
    data
  }
}

function fail(code: string, message: string): AppResult<never> {
  return {
    ok: false,
    error: {
      code,
      message
    }
  }
}

function isAudioPayload(payload: unknown): payload is AudioTranscriptionPayload {
  const value = payload as AudioTranscriptionPayload

  return value?.audio instanceof ArrayBuffer && typeof value.mimeType === 'string'
}

function isRealtimeStartPayload(payload: unknown): payload is RealtimeAsrStartPayload {
  const value = payload as RealtimeAsrStartPayload

  return value === undefined || value.sampleRate === undefined || typeof value.sampleRate === 'number'
}

function isRealtimePushPayload(payload: unknown): payload is RealtimeAsrPushPayload {
  const value = payload as RealtimeAsrPushPayload

  return value?.audio instanceof ArrayBuffer && typeof value.sessionId === 'string'
}

function isRealtimeStopPayload(payload: unknown): payload is RealtimeAsrStopPayload {
  const value = payload as RealtimeAsrStopPayload

  return typeof value?.sessionId === 'string'
}

function getIpcMain(): IpcMainLike {
  const electron = require('electron') as ElectronRuntime

  return electron.ipcMain
}

export function registerVoiceHandlers(
  ipc: IpcMainLike = getIpcMain(),
  asrProvider: AsrProvider = createVolcengineAsrProvider(),
  streamingAsrProvider: StreamingAsrProvider = createUnavailableStreamingAsrProvider()
): void {
  ipc.handle('voice.startRecording', () => ok({ ready: true }))

  ipc.handle('voice.startRealtime', async (_event, payload) => {
    if (!isRealtimeStartPayload(payload)) {
      return fail('VOICE_INVALID_REALTIME_PAYLOAD', '实时语音启动参数不正确')
    }

    try {
      return ok(await streamingAsrProvider.start(payload ?? {}))
    } catch (error) {
      return fail(
        error instanceof RealtimeVoiceError ? error.code : 'REALTIME_ASR_FAILED',
        error instanceof Error ? error.message : '实时语音识别启动失败'
      )
    }
  })

  ipc.handle('voice.pushRealtimeAudio', async (_event, payload) => {
    if (!isRealtimePushPayload(payload)) {
      return fail('VOICE_INVALID_REALTIME_PAYLOAD', '实时语音音频数据不正确')
    }

    try {
      return ok(await streamingAsrProvider.pushAudio(payload))
    } catch (error) {
      return fail(
        error instanceof RealtimeVoiceError ? error.code : 'REALTIME_ASR_FAILED',
        error instanceof Error ? error.message : '实时语音识别失败'
      )
    }
  })

  ipc.handle('voice.stopRealtime', async (_event, payload) => {
    if (!isRealtimeStopPayload(payload)) {
      return fail('VOICE_INVALID_REALTIME_PAYLOAD', '实时语音停止参数不正确')
    }

    try {
      return ok(await streamingAsrProvider.stop(payload))
    } catch (error) {
      return fail(
        error instanceof RealtimeVoiceError ? error.code : 'REALTIME_ASR_FAILED',
        error instanceof Error ? error.message : '实时语音识别停止失败'
      )
    }
  })

  ipc.handle('voice.stopAndTranscribe', async (_event, payload) => {
    if (!isAudioPayload(payload)) {
      return fail('VOICE_INVALID_PAYLOAD', '语音数据格式不正确')
    }

    try {
      const result = await asrProvider.transcribe(payload)
      return ok(result)
    } catch (error) {
      if (error instanceof VolcengineAsrError && error.code === 'ASR_NOT_CONFIGURED') {
        return fail('ASR_NOT_CONFIGURED', error.message)
      }

      return fail(
        'VOICE_TRANSCRIBE_FAILED',
        error instanceof Error ? error.message : '语音识别失败'
      )
    }
  })
}
