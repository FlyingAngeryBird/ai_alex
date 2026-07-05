import { describe, expect, it, vi } from 'vitest'
import { registerAppHandlers } from '../electron/main/ipc/appHandlers'

describe('app IPC handlers', () => {
  it('reports the desktop runtime and active music provider truthfully', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }

    registerAppHandlers(ipcMain, {
      askForMicrophoneAccess: vi.fn()
    })

    expect(handlers.get('app.getRuntimeState')?.(null)).toEqual({
      ok: true,
      data: {
        musicConfigured: true,
        platform: process.platform,
        ready: true,
        musicProvider: 'gdstudio'
      }
    })
  })

  it('reports GD Studio when it is selected', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }

    registerAppHandlers(
      ipcMain,
      {
        askForMicrophoneAccess: vi.fn()
      }
    )

    expect(handlers.get('app.getRuntimeState')?.(null)).toEqual({
      ok: true,
      data: {
        musicConfigured: true,
        platform: process.platform,
        ready: true,
        musicProvider: 'gdstudio'
      }
    })
  })

  it('uses GD Studio by default because it does not require user credentials', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }

    registerAppHandlers(
      ipcMain,
      {
        askForMicrophoneAccess: vi.fn()
      }
    )

    expect(handlers.get('app.getRuntimeState')?.(null)).toEqual({
      ok: true,
      data: {
        musicConfigured: true,
        platform: process.platform,
        ready: true,
        musicProvider: 'gdstudio'
      }
    })
  })

  it('requests microphone access through the desktop runtime', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }
    const askForMicrophoneAccess = vi.fn(async () => ({
      granted: true,
      status: 'granted' as const
    }))

    registerAppHandlers(ipcMain, {
      askForMicrophoneAccess
    })

    await expect(handlers.get('app.requestMicrophoneAccess')?.(null)).resolves.toEqual({
      ok: true,
      data: {
        granted: true,
        status: 'granted'
      }
    })
    expect(askForMicrophoneAccess).toHaveBeenCalledTimes(1)
  })
})
