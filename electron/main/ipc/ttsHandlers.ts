import { createRequire } from 'node:module'
import {
  createUnavailableStreamingTtsProvider,
  RealtimeVoiceError,
  type StreamingTtsProvider,
  type StreamingTtsPushPayload,
  type StreamingTtsStartPayload,
  type StreamingTtsStopPayload,
  type TtsSpeakPayload
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

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
}

type ElectronRuntime = {
  ipcMain: IpcMainLike
}

const require = createRequire(import.meta.url)

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

function getIpcMain(): IpcMainLike {
  const electron = require('electron') as ElectronRuntime

  return electron.ipcMain
}

function isSpeakPayload(payload: unknown): payload is TtsSpeakPayload {
  const value = payload as TtsSpeakPayload

  return typeof value?.text === 'string' && value.text.trim().length > 0
}

function isStreamingStartPayload(payload: unknown): payload is StreamingTtsStartPayload {
  const value = payload as StreamingTtsStartPayload

  return value === undefined || value.voice === undefined || typeof value.voice === 'string'
}

function isStreamingPushPayload(payload: unknown): payload is StreamingTtsPushPayload {
  const value = payload as StreamingTtsPushPayload

  return typeof value?.sessionId === 'string' && typeof value.text === 'string'
}

function isStreamingStopPayload(payload: unknown): payload is StreamingTtsStopPayload {
  const value = payload as StreamingTtsStopPayload

  return typeof value?.sessionId === 'string'
}

function normalizeTtsError(error: unknown, fallback: string): AppResult<never> {
  return fail(
    error instanceof RealtimeVoiceError ? error.code : 'STREAMING_TTS_FAILED',
    error instanceof Error ? error.message : fallback
  )
}

export function registerTtsHandlers(
  ipc: IpcMainLike = getIpcMain(),
  provider: StreamingTtsProvider = createUnavailableStreamingTtsProvider()
): void {
  ipc.handle('tts.speak', async (_event, payload) => {
    if (!isSpeakPayload(payload)) {
      return fail('TTS_INVALID_PAYLOAD', '语音合成文本不能为空')
    }

    try {
      return ok(await provider.speak(payload))
    } catch (error) {
      return normalizeTtsError(error, '语音合成失败')
    }
  })

  ipc.handle('tts.startStreaming', async (_event, payload) => {
    if (!isStreamingStartPayload(payload)) {
      return fail('TTS_INVALID_STREAM_PAYLOAD', '语音合成启动参数不正确')
    }

    try {
      return ok(await provider.start(payload ?? {}))
    } catch (error) {
      return normalizeTtsError(error, '语音合成 2.0 启动失败')
    }
  })

  ipc.handle('tts.pushText', async (_event, payload) => {
    if (!isStreamingPushPayload(payload)) {
      return fail('TTS_INVALID_STREAM_PAYLOAD', '语音合成文本参数不正确')
    }

    try {
      return ok(await provider.pushText(payload))
    } catch (error) {
      return normalizeTtsError(error, '语音合成 2.0 推送失败')
    }
  })

  ipc.handle('tts.stopStreaming', async (_event, payload) => {
    if (!isStreamingStopPayload(payload)) {
      return fail('TTS_INVALID_STREAM_PAYLOAD', '语音合成停止参数不正确')
    }

    try {
      return ok(await provider.stop(payload))
    } catch (error) {
      return normalizeTtsError(error, '语音合成 2.0 停止失败')
    }
  })
}
