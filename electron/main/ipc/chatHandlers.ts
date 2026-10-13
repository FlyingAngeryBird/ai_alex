import { createRequire } from 'node:module'
import {
  createVolcengineLlmProvider,
  VolcengineLlmError,
  type AssistantOutput,
  type ChatMessage,
  type LlmProvider
} from '../providers/llmProvider.js'
import { getDefaultConfigStore, type ConfigStore } from '../config/configStore.js'

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
  configStore: ConfigStore = getDefaultConfigStore()
): void {
  clearMemory()
  let activeSystemPrompt: string | null = null

  function getSystemPrompt(): string {
    const systemPrompt = configStore.getConfig().persona.systemPrompt

    if (activeSystemPrompt !== null && activeSystemPrompt !== systemPrompt) {
      clearMemory()
    }

    activeSystemPrompt = systemPrompt
    return systemPrompt
  }

  ipc.handle('chat.sendMessage', async (_event, payload): Promise<AppResult<AssistantOutput>> => {
    if (!isChatPayload(payload)) {
      return fail('CHAT_INVALID_PAYLOAD', '对话内容不能为空')
    }

    const text = payload.text.trim()
    const systemPrompt = getSystemPrompt()

    try {
      const result = await provider.sendMessage(createLlmMessages(text, systemPrompt))

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
    const sender = (event as { sender?: { send(channel: string, data: unknown): void } }).sender

    function pushChunk(chunk: unknown): void {
      sender?.send('chat.streamChunk', chunk)
    }

    try {
      const result = await provider.streamMessage(createLlmMessages(text, systemPrompt), {
        onChunk: (delta) => pushChunk({ delta }),
        onRawChunk: () => pushChunk({ diagnostic: 'llm_raw_delta' }),
        onResponseStart: () => pushChunk({ diagnostic: 'llm_response_start' })
      })

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
