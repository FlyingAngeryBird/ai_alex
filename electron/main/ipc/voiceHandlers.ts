import { createRequire } from 'node:module'

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

const mockAsrProvider: AsrProvider = {
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

function getIpcMain(): IpcMainLike {
  const electron = require('electron') as ElectronRuntime

  return electron.ipcMain
}

export function registerVoiceHandlers(
  ipc: IpcMainLike = getIpcMain(),
  asrProvider: AsrProvider = mockAsrProvider
): void {
  ipc.handle('voice.startRecording', () => ok({ ready: true }))

  ipc.handle('voice.stopAndTranscribe', async (_event, payload) => {
    if (!isAudioPayload(payload)) {
      return fail('VOICE_INVALID_PAYLOAD', '语音数据格式不正确')
    }

    try {
      const result = await asrProvider.transcribe(payload)
      return ok(result)
    } catch (error) {
      return fail(
        'VOICE_TRANSCRIBE_FAILED',
        error instanceof Error ? error.message : '语音识别失败'
      )
    }
  })
}
