import { createRequire } from 'node:module'
import { getDefaultConfigStore, type ConfigPatch, type ConfigStore } from '../config/configStore.js'

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

function isVoiceOption(value: unknown): value is { id: string; name: string } {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { id: unknown }).id === 'string' &&
    typeof (value as { name: unknown }).name === 'string'
  )
}

function isConfigPatch(payload: unknown): payload is ConfigPatch {
  if (payload == null || typeof payload !== 'object') {
    return false
  }

  const value = payload as Record<string, unknown>

  if (value.persona !== undefined) {
    if (value.persona == null || typeof value.persona !== 'object') {
      return false
    }

    const persona = value.persona as Record<string, unknown>

    if (persona.systemPrompt !== undefined && typeof persona.systemPrompt !== 'string') {
      return false
    }
  }

  if (value.voice !== undefined) {
    if (value.voice == null || typeof value.voice !== 'object') {
      return false
    }

    const voice = value.voice as Record<string, unknown>

    if (voice.activeVoiceId !== undefined && typeof voice.activeVoiceId !== 'string') {
      return false
    }

    if (voice.voices !== undefined) {
      if (!Array.isArray(voice.voices) || !voice.voices.every(isVoiceOption)) {
        return false
      }
    }
  }

  return true
}

function getIpcMain(): IpcMainLike {
  const electron = require('electron') as ElectronRuntime

  return electron.ipcMain
}

export function registerConfigHandlers(
  ipc: IpcMainLike = getIpcMain(),
  store: ConfigStore = getDefaultConfigStore()
): void {
  ipc.handle('config.get', () => ok(store.getConfig()))

  ipc.handle('config.update', async (_event, payload) => {
    if (!isConfigPatch(payload)) {
      return fail('CONFIG_INVALID_PAYLOAD', '配置参数不正确')
    }

    try {
      return ok(await store.updateConfig(payload))
    } catch (error) {
      return fail(
        'CONFIG_UPDATE_FAILED',
        error instanceof Error ? error.message : '配置保存失败'
      )
    }
  })
}
