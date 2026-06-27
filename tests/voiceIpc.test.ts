import { describe, expect, it, vi } from 'vitest'
import { registerVoiceHandlers } from '../electron/main/ipc/voiceHandlers'

describe('voice IPC handlers', () => {
  it('routes audio payloads through the ASR provider', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }
    const transcribe = vi.fn(async () => ({
      text: '我想试试实时对话'
    }))

    registerVoiceHandlers(ipcMain, {
      transcribe
    })

    const handler = handlers.get('voice.stopAndTranscribe')
    const result = await handler?.(null, {
      audio: new ArrayBuffer(8),
      mimeType: 'audio/webm'
    })

    expect(ipcMain.handle).toHaveBeenCalledWith('voice.stopAndTranscribe', expect.any(Function))
    expect(transcribe).toHaveBeenCalledWith({
      audio: expect.any(ArrayBuffer),
      mimeType: 'audio/webm'
    })
    expect(result).toEqual({
      ok: true,
      data: {
        text: '我想试试实时对话'
      }
    })
  })

  it('routes realtime audio controls through the streaming ASR provider', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }
    const realtimeProvider = {
      pushAudio: vi.fn(async () => ({
        partialText: '你好'
      })),
      start: vi.fn(async () => ({
        sessionId: 'asr-session-1'
      })),
      stop: vi.fn(async () => ({
        text: '你好，lingmo'
      }))
    }

    registerVoiceHandlers(
      ipcMain,
      {
        transcribe: vi.fn()
      },
      realtimeProvider
    )

    expect(await handlers.get('voice.startRealtime')?.(null, { sampleRate: 16000 })).toEqual({
      ok: true,
      data: {
        sessionId: 'asr-session-1'
      }
    })
    expect(await handlers.get('voice.pushRealtimeAudio')?.(null, {
      audio: new ArrayBuffer(12),
      sessionId: 'asr-session-1'
    })).toEqual({
      ok: true,
      data: {
        partialText: '你好'
      }
    })
    expect(await handlers.get('voice.stopRealtime')?.(null, { sessionId: 'asr-session-1' })).toEqual({
      ok: true,
      data: {
        text: '你好，lingmo'
      }
    })

    expect(realtimeProvider.start).toHaveBeenCalledWith({ sampleRate: 16000 })
    expect(realtimeProvider.pushAudio).toHaveBeenCalledWith({
      audio: expect.any(ArrayBuffer),
      sessionId: 'asr-session-1'
    })
    expect(realtimeProvider.stop).toHaveBeenCalledWith({ sessionId: 'asr-session-1' })
  })
})
