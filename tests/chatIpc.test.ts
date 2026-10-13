import { describe, expect, it, vi } from 'vitest'
import { registerChatHandlers } from '../electron/main/ipc/chatHandlers'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1PersonaStore } from '../electron/main/r1/persona'

describe('chat IPC handlers', () => {
  it('uses the current versioned persona on the next conversation turn', async () => {
    const db = openR1Database(':memory:')
    try {
      const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
      const ipc = { handle: (channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      } }
      const provider = { sendMessage: vi.fn(async (_messages: unknown[]) => ({ intent: 'chat' as const,
        music: null, reply: '你好' })), streamMessage: vi.fn() }
      const persona = new R1PersonaStore(db)
      registerChatHandlers(ipc, provider, undefined, new R1Conversations(db), persona,
        { releaseId: 'test', toolAliases: [],
          compose: (current) => `PERSONA:${current.assistantName}:${current.version}` })
      await handlers.get('chat.sendMessage')?.(null, { text: '你好' })
      expect(provider.sendMessage.mock.calls[0]?.[0]?.[0]).toMatchObject({
        role: 'system', content: 'PERSONA:Seamo AI:1'
      })
      persona.update({ expectedVersion: 1, assistantName: 'Alex' })
      await handlers.get('chat.sendMessage')?.(null, { text: '你叫什么' })
      expect(provider.sendMessage.mock.calls[1]?.[0]?.[0]).toMatchObject({
        role: 'system', content: 'PERSONA:Alex:2'
      })
    } finally { db.close() }
  })
  it('generates a greeting without saving its internal instruction as user history', async () => {
    const db = openR1Database(':memory:')
    try {
      const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
      const ipc = { handle: (channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      } }
      const provider = { sendMessage: vi.fn(async () => ({ intent: 'chat' as const, music: null,
        reply: '今天想聊些什么？' })), streamMessage: vi.fn() }
      registerChatHandlers(ipc, provider, undefined, new R1Conversations(db))
      expect(await handlers.get('chat.greeting')?.(null)).toMatchObject({ ok: true,
        data: { intent: 'chat', reply: '今天想聊些什么？' } })
      expect(provider.sendMessage).toHaveBeenCalledWith(expect.arrayContaining([
        expect.objectContaining({ role: 'system' })
      ]))
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toMatchObject({ count: 0 })
    } finally { db.close() }
  })
  it('persists normal turns, isolates temporary turns, and discards an old in-flight reply', async () => {
    const db = openR1Database(':memory:')
    try {
      const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
      const ipc = { handle: (channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      } }
      let release: (value: { intent: 'chat'; music: null; reply: string }) => void = () => undefined
      const provider = { sendMessage: vi.fn(async () => ({ intent: 'chat' as const, music: null, reply: '回答' })),
        streamMessage: vi.fn(() => new Promise<{ intent: 'chat'; music: null; reply: string }>((resolve) => {
          release = resolve
        })) }
      registerChatHandlers(ipc, provider, undefined, new R1Conversations(db))
      await handlers.get('chat.sendMessage')?.(null, { text: '普通内容' })
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toMatchObject({ count: 2 })
      expect(handlers.get('chat.setTemporary')?.(null, { enabled: true }))
        .toEqual({ ok: true, data: { temporary: true } })
      await handlers.get('chat.sendMessage')?.(null, { text: '临时内容' })
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toMatchObject({ count: 2 })
      const pending = handlers.get('chat.streamMessage')?.(null, { text: '临时请求' }) as Promise<unknown>
      expect(handlers.get('chat.setTemporary')?.(null, { enabled: false }))
        .toEqual({ ok: true, data: { temporary: false } })
      release({ intent: 'chat', music: null, reply: '旧回答' })
      expect(await pending).toMatchObject({ ok: false, error: { code: 'SESSION_CHANGED' } })
      expect(db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toMatchObject({ count: 2 })
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages WHERE body = '临时内容'").get())
        .toMatchObject({ count: 0 })
    } finally { db.close() }
  })
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
      })),
      streamMessage: vi.fn(async () => ({
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
      sendMessage: vi.fn(),
      streamMessage: vi.fn()
    })

    await expect(handlers.get('chat.sendMessage')?.(null, { text: ' ' })).resolves.toEqual({
      ok: false,
      error: {
        code: 'CHAT_INVALID_PAYLOAD',
        message: '对话内容不能为空'
      }
    })
  })

  it('uses systemPrompt from the injected configStore', async () => {
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
        reply: '好的'
      })),
      streamMessage: vi.fn(async () => ({
        intent: 'chat' as const,
        music: null,
        reply: '好的'
      }))
    }
    const configStore = {
      getConfig: vi.fn(() => ({
        persona: { systemPrompt: 'CUSTOM_PROMPT' },
        voice: { voices: [], activeVoiceId: '' }
      })),
      loadConfig: vi.fn(async () => ({
        persona: { systemPrompt: 'CUSTOM_PROMPT' },
        voice: { voices: [], activeVoiceId: '' }
      })),
      updateConfig: vi.fn(async () => ({
        persona: { systemPrompt: 'CUSTOM_PROMPT' },
        voice: { voices: [], activeVoiceId: '' }
      }))
    }

    registerChatHandlers(ipcMain, provider, configStore)

    await handlers.get('chat.sendMessage')?.(null, { text: '你好' })

    expect(configStore.getConfig).toHaveBeenCalled()
    expect(provider.sendMessage).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: 'CUSTOM_PROMPT' })
      ])
    )
  })

  it('drops old conversation memory when the system prompt changes', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }
    let systemPrompt = '你是 lingmo。'
    const provider = {
      sendMessage: vi.fn(async (_messages: unknown) => ({
        intent: 'chat' as const,
        music: null,
        reply: systemPrompt.includes('Alex') ? '我是 Alex。' : '我是 lingmo。'
      })),
      streamMessage: vi.fn(async (_messages: unknown) => ({
        intent: 'chat' as const,
        music: null,
        reply: systemPrompt.includes('Alex') ? '我是 Alex。' : '我是 lingmo。'
      }))
    }
    const configStore = {
      getConfig: vi.fn(() => ({
        persona: { systemPrompt },
        voice: { voices: [], activeVoiceId: '' }
      })),
      loadConfig: vi.fn(),
      updateConfig: vi.fn()
    }

    registerChatHandlers(ipcMain, provider, configStore)

    await handlers.get('chat.sendMessage')?.(null, { text: '你是谁' })
    systemPrompt = '你是 Alex。'
    await handlers.get('chat.sendMessage')?.(null, { text: '你是谁' })

    const secondMessages = provider.sendMessage.mock.calls[1][0]

    expect(secondMessages).toEqual([
      { content: '你是 Alex。', role: 'system' },
      { content: '你是谁', role: 'user' }
    ])
  })

  it('streams chunks via chat.streamMessage and returns final output', async () => {
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
    const provider = {
      sendMessage: vi.fn(),
      streamMessage: vi.fn(async (_messages: unknown, callbacks: { onChunk: (delta: string) => void }) => {
        callbacks.onChunk('你')
        callbacks.onChunk('好')
        return { intent: 'chat' as const, music: null, reply: '你好' }
      })
    }

    registerChatHandlers(ipcMain, provider)

    const result = await handlers.get('chat.streamMessage')?.({ sender }, { text: 'hi' })

    expect(result).toEqual({
      ok: true,
      data: { intent: 'chat', music: null, reply: '你好' }
    })
    expect(sent).toEqual([
      { channel: 'chat.streamChunk', data: { delta: '你' } },
      { channel: 'chat.streamChunk', data: { delta: '好' } },
      { channel: 'chat.streamChunk', data: { done: true, intent: 'chat', music: null, reply: '你好' } }
    ])
  })
})
