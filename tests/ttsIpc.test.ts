import { describe, expect, it, vi } from 'vitest'
import { registerTtsHandlers } from '../electron/main/ipc/ttsHandlers'

type TtsAudioChunk = { audio: ArrayBuffer; isFinal: boolean }

describe('TTS IPC handlers', () => {
  it('routes streaming TTS controls and forwards audio chunks via the event channel', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }
    const sent: Array<{ channel: string; data: unknown }> = []
    const sender = {
      send: vi.fn((channel: string, data: unknown) => {
        sent.push({ channel, data })
      })
    }
    let capturedOnAudio: ((chunk: TtsAudioChunk) => void) | null = null
    const provider = {
      speak: vi.fn(async () => ({
        audio: new ArrayBuffer(8),
        mimeType: 'audio/mpeg'
      })),
      start: vi.fn(async (payload: { voice?: string; onAudio: (chunk: TtsAudioChunk) => void }) => {
        capturedOnAudio = payload.onAudio
        return { sessionId: 'tts-session-1' }
      }),
      pushText: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined)
    }

    registerTtsHandlers(ipcMain, provider)

    expect(await handlers.get('tts.startStreaming')?.({ sender }, { voice: 'default' })).toEqual({
      ok: true,
      data: { sessionId: 'tts-session-1' }
    })
    expect(provider.start).toHaveBeenCalledWith({
      voice: 'default',
      onAudio: expect.any(Function)
    })

    ;(capturedOnAudio as ((chunk: TtsAudioChunk) => void) | null)?.({
      audio: new ArrayBuffer(4),
      isFinal: false
    })
    expect(sent).toContainEqual({
      channel: 'tts.streamAudio',
      data: { audio: expect.any(ArrayBuffer), isFinal: false }
    })

    expect(
      await handlers.get('tts.pushText')?.(null, { sessionId: 'tts-session-1', text: '你好' })
    ).toEqual({ ok: true, data: undefined })
    expect(provider.pushText).toHaveBeenCalledWith({
      sessionId: 'tts-session-1',
      text: '你好'
    })

    expect(await handlers.get('tts.stopStreaming')?.(null, { sessionId: 'tts-session-1' })).toEqual({
      ok: true,
      data: undefined
    })
    expect(provider.stop).toHaveBeenCalledWith({ sessionId: 'tts-session-1' })
  })
})
