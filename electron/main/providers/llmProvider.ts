export type ChatMessage = {
  content: string
  role: 'assistant' | 'system' | 'user'
}

export type AssistantOutput = {
  intent: 'chat' | 'play_music'
  music: {
    keyword: string
  } | null
  reply: string
}

export type LlmProvider = {
  sendMessage(messages: ChatMessage[]): Promise<AssistantOutput>
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

type VolcengineLlmEnvironment = {
  VOLCENGINE_ARK_API_KEY?: string
  VOLCENGINE_ARK_BASE_URL?: string
  VOLCENGINE_ARK_MODEL?: string
}

type VolcengineLlmOptions = {
  env?: VolcengineLlmEnvironment
  fetch?: FetchLike
  timeoutMs?: number
}

type ArkChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string
    }
  }>
  error?: {
    message?: string
  }
  message?: string
}

const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'
const DEFAULT_TIMEOUT_MS = 12000
const JSON_RESPONSE_SYSTEM_PROMPT: ChatMessage = {
  content: '请始终只返回 JSON object，格式为 {"reply":"回复文本","intent":"chat","music":null}。',
  role: 'system'
}

export class VolcengineLlmError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'VolcengineLlmError'
  }
}

function getConfig(options: VolcengineLlmOptions): {
  apiKey: string
  baseUrl: string
  model: string
} {
  const env = options.env ?? process.env
  const apiKey = env.VOLCENGINE_ARK_API_KEY?.trim()
  const model = env.VOLCENGINE_ARK_MODEL?.trim()

  if (!apiKey || !model) {
    throw new VolcengineLlmError('LLM_NOT_CONFIGURED', '豆包对话模型还没有配置 API Key 或模型名。')
  }

  return {
    apiKey,
    baseUrl: (env.VOLCENGINE_ARK_BASE_URL || DEFAULT_ARK_BASE_URL).replace(/\/$/, ''),
    model
  }
}

function isAssistantOutput(value: unknown): value is AssistantOutput {
  const output = value as AssistantOutput

  return (
    typeof output?.reply === 'string' &&
    (output.intent === 'chat' || output.intent === 'play_music') &&
    (output.music === null || typeof output.music?.keyword === 'string')
  )
}

export function parseAssistantOutput(raw: string): AssistantOutput {
  try {
    const parsed = JSON.parse(raw) as unknown

    if (isAssistantOutput(parsed)) {
      return parsed
    }
  } catch {
    // Plain text is acceptable; the system prompt asks for JSON but models can drift.
  }

  return {
    intent: 'chat',
    music: null,
    reply: raw.trim() || '我在。刚才那句话我没有理解完整，可以再说一次吗？'
  }
}

async function parseJsonResponse(response: Response): Promise<ArkChatCompletionResponse> {
  const text = await response.text()

  if (!text.trim()) {
    return {}
  }

  return JSON.parse(text) as ArkChatCompletionResponse
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => {
      reject(new VolcengineLlmError('LLM_TIMEOUT', '豆包对话模型响应超时。'))
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer)
    }
  })
}

function ensureJsonInstruction(messages: ChatMessage[]): ChatMessage[] {
  if (messages.some((message) => /json/i.test(message.content))) {
    return messages
  }

  return [JSON_RESPONSE_SYSTEM_PROMPT, ...messages]
}

export function createVolcengineLlmProvider(options: VolcengineLlmOptions = {}): LlmProvider {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    async sendMessage(messages: ChatMessage[]): Promise<AssistantOutput> {
      const config = getConfig(options)
      const requestMessages = ensureJsonInstruction(messages)
      const response = await withTimeout(
        fetcher(`${config.baseUrl}/chat/completions`, {
          body: JSON.stringify({
            messages: requestMessages,
            model: config.model,
            response_format: {
              type: 'json_object'
            },
            stream: false,
            temperature: 0.8
          }),
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json'
          },
          method: 'POST'
        }),
        timeoutMs
      )
      const body = await parseJsonResponse(response)

      if (!response.ok) {
        throw new VolcengineLlmError(
          'LLM_REQUEST_FAILED',
          body.error?.message || body.message || '豆包对话模型请求失败。'
        )
      }

      const content = body.choices?.[0]?.message?.content?.trim()

      if (!content) {
        throw new VolcengineLlmError('LLM_EMPTY_RESPONSE', '豆包对话模型没有返回内容。')
      }

      return parseAssistantOutput(content)
    }
  }
}
