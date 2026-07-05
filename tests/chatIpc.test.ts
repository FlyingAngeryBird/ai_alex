import { describe, expect, it, vi } from 'vitest'
import { registerChatHandlers } from '../electron/main/ipc/chatHandlers'

describe('chat IPC handlers', () => {
  it('keeps short conversation memory and routes messages to LLM provider', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }
    const provider = {
      sendMessage: vi.fn(async () => ({
        intent: 'chat' as const,
        music: null,
        reply: '我记得你刚才说想放松一下。'
      }))
    }

    registerChatHandlers(ipcMain, provider)

    const result = await handlers.get('chat.sendMessage')?.(null, {
      text: '我今天有点累'
    })

    expect(result).toEqual({
      ok: true,
      data: {
        intent: 'chat',
        music: null,
        reply: '我记得你刚才说想放松一下。'
      }
    })
    expect(provider.sendMessage).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        {
          content: '我今天有点累',
          role: 'user'
        }
      ])
    )
  })

  it('rejects empty message payloads', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }

    registerChatHandlers(ipcMain, {
      sendMessage: vi.fn()
    })

    await expect(handlers.get('chat.sendMessage')?.(null, { text: ' ' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'CHAT_INVALID_PAYLOAD',
        message: '对话内容不能为空'
      }
    })
  })
})
