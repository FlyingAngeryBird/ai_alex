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
})
