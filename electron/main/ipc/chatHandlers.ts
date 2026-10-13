import { createRequire } from 'node:module'
import {
  createVolcengineLlmProvider,
  VolcengineLlmError,
  type AssistantOutput,
  type ChatMessage,
  type LlmProvider
} from '../providers/llmProvider.js'
import { getDefaultConfigStore, type ConfigStore } from '../config/configStore.js'
import { randomUUID } from 'node:crypto'
import type { R1Conversations } from '../r1/conversations.js'

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

type ChatPayload = {
  text: string
}

const MAX_MEMORY_MESSAGES = 40
const require = createRequire(import.meta.url)

const memory: ChatMessage[] = []

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

function isChatPayload(payload: unknown): payload is ChatPayload {
  const value = payload as ChatPayload

  return typeof value?.text === 'string' && value.text.trim().length > 0
}

function getIpcMain(): IpcMainLike {
  const electron = require('electron') as ElectronRuntime

  return electron.ipcMain
}

function appendMemory(message: ChatMessage): void {
  memory.push(message)

  if (memory.length > MAX_MEMORY_MESSAGES) {
    memory.splice(0, memory.length - MAX_MEMORY_MESSAGES)
  }
}

function clearMemory(): void {
  memory.splice(0, memory.length)
}

function createLlmMessages(text: string, systemPrompt: string): ChatMessage[] {
  return [
    {
      content: systemPrompt,
      role: 'system'
    },
    ...memory,
    {
      content: text,
      role: 'user'
    }
  ]
}

function normalizeChatError(error: unknown): { code: string; message: string } {
  if (error instanceof Error && error.message === 'SESSION_CHANGED') {
    return { code: 'SESSION_CHANGED', message: '会话已切换，旧回答已丢弃。' }
  }
  if (error instanceof VolcengineLlmError) {
    return {
      code: error.code,
      message: error.message
    }
  }

  return {
    code: 'CHAT_FAILED',
    message: error instanceof Error ? error.message : '对话生成失败'
  }
}

export function registerChatHandlers(
  ipc: IpcMainLike = getIpcMain(),
  provider: LlmProvider = createVolcengineLlmProvider(),
  configStore: ConfigStore = getDefaultConfigStore(),
  conversations?: R1Conversations
): void {
  clearMemory()
  let activeSystemPrompt: string | null = null
  let temporary = false
  let sessionId = conversations?.start(false) ?? null
  let sessionEpoch = 0

  function persistTurn(text: string, reply: string): void {
    if (!conversations || !sessionId) return
    const turnId = randomUUID()
    conversations.append({ sessionId, turnId, role: 'user', body: text, status: 'final' })
    conversations.append({ sessionId, turnId, responseId: randomUUID(), role: 'assistant',
      body: reply, status: 'generated' })
  }

  function getSystemPrompt(): string {
    const systemPrompt = configStore.getConfig().persona.systemPrompt

    if (activeSystemPrompt !== null && activeSystemPrompt !== systemPrompt) {
      clearMemory()
      sessionEpoch += 1
      if (conversations && sessionId) {
        conversations.end(sessionId)
        sessionId = conversations.start(temporary)
      }
    }

    activeSystemPrompt = systemPrompt
    return systemPrompt
  }

  ipc.handle('chat.setTemporary', (_event, payload) => {
    if (!conversations || typeof (payload as { enabled?: unknown })?.enabled !== 'boolean') {
      return fail('INVALID_TEMPORARY_MODE', '临时对话状态不可用')
    }
    const enabled = (payload as { enabled: boolean }).enabled
    if (enabled === temporary) return ok({ temporary })
    clearMemory()
    sessionEpoch += 1
    if (sessionId) conversations.end(sessionId)
    temporary = enabled
    sessionId = conversations.start(temporary)
    return ok({ temporary })
  })

  ipc.handle('chat.greeting', async (): Promise<AppResult<AssistantOutput>> => {
    const systemPrompt = getSystemPrompt()
    try {
      const result = await provider.sendMessage([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: '请用一句自然、简短的中文向用户问好。不要描述这条内部请求。' }
      ])
      return ok({ intent: 'chat', music: null, reply: result.reply })
    } catch (error) {
      const normalized = normalizeChatError(error)
      return fail(normalized.code, normalized.message)
    }
  })

  ipc.handle('chat.sendMessage', async (_event, payload): Promise<AppResult<AssistantOutput>> => {
    if (!isChatPayload(payload)) {
      return fail('CHAT_INVALID_PAYLOAD', '对话内容不能为空')
    }

    const text = payload.text.trim()
    const systemPrompt = getSystemPrompt()
    const requestEpoch = sessionEpoch

    try {
      const result = await provider.sendMessage(createLlmMessages(text, systemPrompt))
      if (requestEpoch !== sessionEpoch) throw new Error('SESSION_CHANGED')
      persistTurn(text, result.reply)

      appendMemory({
        content: text,
        role: 'user'
      })
      appendMemory({
        content: result.reply,
        role: 'assistant'
      })

      return ok(result)
    } catch (error) {
      const normalized = normalizeChatError(error)
      return fail(normalized.code, normalized.message)
    }
  })

  ipc.handle('chat.streamMessage', async (event, payload): Promise<AppResult<AssistantOutput>> => {
    if (!isChatPayload(payload)) {
      return fail('CHAT_INVALID_PAYLOAD', '对话内容不能为空')
    }

    const text = payload.text.trim()
    const systemPrompt = getSystemPrompt()
    const requestEpoch = sessionEpoch
    const sender = (event as { sender?: { send(channel: string, data: unknown): void } } | null)?.sender

    function pushChunk(chunk: unknown): void {
      sender?.send('chat.streamChunk', chunk)
    }

    try {
      const result = await provider.streamMessage(createLlmMessages(text, systemPrompt), {
        onChunk: (delta) => pushChunk({ delta }),
        onRawChunk: () => pushChunk({ diagnostic: 'llm_raw_delta' }),
        onResponseStart: () => pushChunk({ diagnostic: 'llm_response_start' })
      })
      if (requestEpoch !== sessionEpoch) throw new Error('SESSION_CHANGED')
      persistTurn(text, result.reply)

      appendMemory({
        content: text,
        role: 'user'
      })
      appendMemory({
        content: result.reply,
        role: 'assistant'
      })

      pushChunk({
        done: true,
        intent: result.intent,
        music: result.music,
        reply: result.reply
      })

      return ok(result)
    } catch (error) {
      const normalized = normalizeChatError(error)
      pushChunk({ done: true, error: normalized })
      return fail(normalized.code, normalized.message)
    }
  })
}
