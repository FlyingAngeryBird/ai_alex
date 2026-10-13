import { describe, expect, it, vi } from 'vitest'
import { registerConfigHandlers } from '../electron/main/ipc/configHandlers'
import type { ConfigStore } from '../electron/main/config/configStore'

function createFakeStore() {
  return {
    getConfig: vi.fn(() => ({
      persona: { systemPrompt: 'prompt-a' },
      voice: { voices: [], activeVoiceId: 'voice-a' }
    })),
    loadConfig: vi.fn(async () => ({
      persona: { systemPrompt: 'prompt-a' },
      voice: { voices: [], activeVoiceId: 'voice-a' }
    })),
    updateConfig: vi.fn(async () => ({
      persona: { systemPrompt: 'prompt-b' },
      voice: { voices: [], activeVoiceId: 'voice-b' }
    }))
  } as unknown as ConfigStore
}

function setupHandlers(store: ConfigStore = createFakeStore()) {
  const handlers = new Map<string, (_event: unknown, payload?: unknown) => unknown>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }

  registerConfigHandlers(ipcMain, store)

  return { handlers, store }
}

describe('config IPC handlers', () => {
  it('returns current config via config.get', async () => {
    const { handlers } = setupHandlers()

    const result = await handlers.get('config.get')?.(null)

    expect(result).toEqual({
      ok: true,
      data: {
        persona: { systemPrompt: 'prompt-a' },
        voice: { voices: [], activeVoiceId: 'voice-a' }
      }
    })
  })

  it('persists patch via config.update and returns merged config', async () => {
    const store = createFakeStore()
    const { handlers } = setupHandlers(store)

    const result = await handlers.get('config.update')?.(null, {
      voice: { voices: [{ id: 'voice-b', name: 'B' }], activeVoiceId: 'voice-b' }
    })

    expect(store.updateConfig).toHaveBeenCalledWith({
      voice: { voices: [{ id: 'voice-b', name: 'B' }], activeVoiceId: 'voice-b' }
    })
    expect(result).toEqual({
      ok: true,
      data: {
        persona: { systemPrompt: 'prompt-b' },
        voice: { voices: [], activeVoiceId: 'voice-b' }
      }
    })
  })

  it('rejects invalid patch shapes', async () => {
    const { handlers } = setupHandlers()

    const result = await handlers.get('config.update')?.(null, {
      persona: { systemPrompt: 123 }
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'CONFIG_INVALID_PAYLOAD',
        message: '配置参数不正确'
      }
    })
  })

  it('rejects voice option entries missing required fields', async () => {
    const { handlers } = setupHandlers()

    const result = await handlers.get('config.update')?.(null, {
      voice: { voices: [{ id: 'voice-b' }] }
    })

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'CONFIG_INVALID_PAYLOAD',
        message: '配置参数不正确'
      }
    })
  })
})
