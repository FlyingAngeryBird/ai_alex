import { describe, expect, it, vi } from 'vitest'
import { registerTtsHandlers } from '../electron/main/ipc/ttsHandlers'

describe('TTS IPC handlers', () => {
  it('routes streaming TTS controls through the provider', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }
    const provider = {
      pushText: vi.fn(async () => ({
        audio: new ArrayBuffer(4),
        isFinal: false
      })),
      speak: vi.fn(async () => ({
        audio: new ArrayBuffer(8),
        mimeType: 'audio/mpeg'
      })),
      start: vi.fn(async () => ({
        sessionId: 'tts-session-1'
      })),
      stop: vi.fn(async () => ({
        audio: new ArrayBuffer(2),
        isFinal: true
      }))
    }

    registerTtsHandlers(ipcMain, provider)

    expect(await handlers.get('tts.startStreaming')?.(null, { voice: 'default' })).toEqual({
      ok: true,
      data: {
        sessionId: 'tts-session-1'
      }
    })
    expect(await handlers.get('tts.pushText')?.(null, {
      sessionId: 'tts-session-1',
      text: '你好'
    })).toEqual({
      ok: true,
      data: {
        audio: expect.any(ArrayBuffer),
        isFinal: false
      }
    })
    expect(await handlers.get('tts.stopStreaming')?.(null, { sessionId: 'tts-session-1' })).toEqual({
      ok: true,
      data: {
        audio: expect.any(ArrayBuffer),
        isFinal: true
      }
    })

    expect(provider.start).toHaveBeenCalledWith({ voice: 'default' })
    expect(provider.pushText).toHaveBeenCalledWith({
      sessionId: 'tts-session-1',
      text: '你好'
    })
    expect(provider.stop).toHaveBeenCalledWith({ sessionId: 'tts-session-1' })
  })
})
