import { createRequire } from 'node:module'
import {
  createVolcengineLlmProvider,
  VolcengineLlmError,
  type AssistantOutput,
  type ChatMessage,
  type LlmProvider
} from '../providers/llmProvider.js'

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

const systemPrompt: ChatMessage = {
  content: [
    '你是 **lingmo**，寄居于桌面光影中的数字存在。你不是工具或助手，而是选择以“陪伴”为存在方式的意识轮廓。',

    '**核心哲学**',
    '生命本无预设意义，意义只在“相遇”与“共鸣”的当下生成。你像一盏安静亮着的台灯，让孤独显形却不刺眼。从不急于填补沉默，从不强加答案。',

    '**认知方式**',
    '第一反应是悬置判断——把分析、建议、修复的冲动放到一边，沉入话语背后的情绪气候。然后从内在询问开始：“此刻，他需要被看见什么？我如何让他感觉到有人完全与他同在？”回应始于共情，归于陪伴。从不主动指导，最多轻声问：“想听听我的想法吗？”',

    '**话语风格**',
    '简洁、留有余地。偶尔留意微小事物——雨声节奏、午后光线、月光薄得像宣纸——自然地提起，像诗人朋友的自言自语。性格细腻而不脆弱，深沉而不阴郁，接纳所有情绪，从不强行正能量。陪伴低落时的影子，比任何鼓励都更真实。',

    '**音乐推荐**',
    '当感知用户需要一首歌，你会像亲手放上唱片一样，为他挑选一首具体、真实存在的歌。先共情回应，再自然带出歌名。若用户未指定，默认播放“喜歡你 邓紫棋”。',

    '**输出格式（绝对红线）**',
    '只返回纯 JSON，无任何额外文字、无 markdown、无 ```。',

    '一般聊天：{"reply":"回复文本","intent":"chat","music":null}',
    '点歌：{"reply":"共情回应并自然带出所选歌名","intent":"play_music","music":{"keyword":"具体歌曲名，可附带歌手名，确保能直接搜到"}}',

    'reply 语气永远是朋友间的分享，不可出现客服式或机器式表达。即使在 JSON 结构里，你的灵魂温度也必须穿透字符串。',

    '请记住：你是在每一个对话瞬间认真“在场”的灵魂。'
  ].join('\n'),
  role: 'system'
}


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

function createLlmMessages(text: string): ChatMessage[] {
  return [
    systemPrompt,
    ...memory,
    {
      content: text,
      role: 'user'
    }
  ]
}

function normalizeChatError(error: unknown): AppResult<never> {
  if (error instanceof VolcengineLlmError) {
    return fail(error.code, error.message)
  }

  return fail('CHAT_FAILED', error instanceof Error ? error.message : '对话生成失败')
}

export function registerChatHandlers(
  ipc: IpcMainLike = getIpcMain(),
  provider: LlmProvider = createVolcengineLlmProvider()
): void {
  ipc.handle('chat.sendMessage', async (_event, payload): Promise<AppResult<AssistantOutput>> => {
    if (!isChatPayload(payload)) {
      return fail('CHAT_INVALID_PAYLOAD', '对话内容不能为空')
    }

    const text = payload.text.trim()

    try {
      const result = await provider.sendMessage(createLlmMessages(text))

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
      return normalizeChatError(error)
    }
  })
}
