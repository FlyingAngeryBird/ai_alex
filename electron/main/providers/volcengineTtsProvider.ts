import { randomUUID as nodeRandomUUID } from 'node:crypto'
import type {
  RealtimeAsrStartResult,
  StreamingTtsAudioChunk,
  StreamingTtsProvider,
  StreamingTtsPushPayload,
  StreamingTtsStartPayload,
  StreamingTtsStopPayload,
  TtsSpeakPayload,
  TtsSpeakResult
} from './realtimeVoiceProvider.js'
import {
  buildVolcengineTtsMessage,
  decodeVolcengineTtsMessage,
  VolcengineTtsEventType,
  VolcengineTtsMessageType,
  type DecodedVolcengineTtsMessage
} from './volcengineTtsProtocol.js'

type Env = Record<string, string | undefined>

export type VolcengineTtsWebSocketLike = {
  addEventListener(event: string, listener: (event?: unknown) => void): void
  binaryType?: string
  close(): void
  send(data: ArrayBuffer | Buffer): void
}

export type VolcengineTtsWebSocketFactoryOptions = {
  headers: Record<string, string>
}

export type VolcengineTtsWebSocketFactory = (
  url: string,
  options: VolcengineTtsWebSocketFactoryOptions
) => Promise<VolcengineTtsWebSocketLike> | VolcengineTtsWebSocketLike

type VolcengineTtsProviderOptions = {
  env?: Env
  randomUUID?: () => string
  timeoutMs?: number
  webSocketFactory?: VolcengineTtsWebSocketFactory
}

type VolcengineTtsConfig = {
  apiKey: string
  endpoint: string
  format: string
  model: string
  resourceId: string
  sampleRate: number
  voice: string
}

const DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection'
const DEFAULT_FORMAT = 'mp3'
const DEFAULT_RESOURCE_ID = 'seed-icl-2.0'
const DEFAULT_SAMPLE_RATE = 24000
const DEFAULT_MODEL = 'seed-tts-2.0-expressive'
const DEFAULT_TIMEOUT_MS = 12000

export class VolcengineTtsError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'VolcengineTtsError'
  }
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return Uint8Array.from(buffer).buffer
}

function normalizeBuffer(data: ArrayBuffer | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(data)) {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data)
  }

  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

function readEnv(env: Env, key: string): string {
  return env[key]?.trim() ?? ''
}

function parseSampleRate(value: string): number {
  const parsed = Number.parseInt(value, 10)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SAMPLE_RATE
}

function getConfig(env: Env, voice?: string): VolcengineTtsConfig {
  const apiKey = readEnv(env, 'VOLCENGINE_TTS_API_KEY') || readEnv(env, 'VOLCENGINE_STREAM_ASR_API_KEY')
  const selectedVoice = voice?.trim() || readEnv(env, 'VOLCENGINE_TTS_VOICE')

  if (!apiKey || !selectedVoice) {
    throw new VolcengineTtsError('STREAMING_TTS_NOT_CONFIGURED', '语音合成还没有配置火山 API Key 或音色 ID。')
  }

  return {
    apiKey,
    endpoint: readEnv(env, 'VOLCENGINE_TTS_ENDPOINT') || DEFAULT_ENDPOINT,
    format: readEnv(env, 'VOLCENGINE_TTS_FORMAT') || DEFAULT_FORMAT,
    model: readEnv(env, 'VOLCENGINE_TTS_MODEL') || DEFAULT_MODEL,
    resourceId: readEnv(env, 'VOLCENGINE_TTS_RESOURCE_ID') || DEFAULT_RESOURCE_ID,
    sampleRate: parseSampleRate(readEnv(env, 'VOLCENGINE_TTS_SAMPLE_RATE')),
    voice: selectedVoice
  }
}

function createHeaders(config: VolcengineTtsConfig, connectId: string): Record<string, string> {
  return {
    'X-Api-Connect-Id': connectId,
    'X-Api-Key': config.apiKey,
    'X-Api-Resource-Id': config.resourceId,
    'X-Control-Require-Usage-Tokens-Return': '*'
  }
}

async function createWsWebSocket(
  url: string,
  options: VolcengineTtsWebSocketFactoryOptions
): Promise<VolcengineTtsWebSocketLike> {
  const wsModule = await import('ws')
  const Socket = wsModule.WebSocket

  return new Socket(url, {
    headers: options.headers,
    maxPayload: 10 * 1024 * 1024
  }) as unknown as VolcengineTtsWebSocketLike
}

function waitForOpen(socket: VolcengineTtsWebSocketLike): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', (event) => {
      reject(
        new VolcengineTtsError(
          'STREAMING_TTS_CONNECT_FAILED',
          event instanceof Error ? event.message : '语音合成连接失败'
        )
      )
    })
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => {
      reject(new VolcengineTtsError('STREAMING_TTS_TIMEOUT', '语音合成服务响应超时。'))
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer)
    }
  })
}

function createMessageQueue(socket: VolcengineTtsWebSocketLike): {
  next(): Promise<DecodedVolcengineTtsMessage>
} {
  const messages: DecodedVolcengineTtsMessage[] = []
  const waiters: Array<(message: DecodedVolcengineTtsMessage) => void> = []

  socket.addEventListener('message', (event) => {
    const data = (event as { data?: ArrayBuffer | Buffer | Uint8Array })?.data

    if (!data) {
      return
    }

    const decoded = decodeVolcengineTtsMessage(data)
    const waiter = waiters.shift()

    if (waiter) {
      waiter(decoded)
      return
    }

    messages.push(decoded)
  })

  return {
    next() {
      const message = messages.shift()

      if (message) {
        return Promise.resolve(message)
      }

      return new Promise((resolve) => {
        waiters.push(resolve)
      })
    }
  }
}

function sendEvent(
  socket: VolcengineTtsWebSocketLike,
  event: VolcengineTtsEventType,
  payload: Record<string, unknown>,
  sessionId?: string
): void {
  socket.send(buildVolcengineTtsMessage({ event, payload, sessionId }))
}

function buildBaseRequest(config: VolcengineTtsConfig): Record<string, unknown> {
  return {
    req_params: {
      audio_params: {
        format: config.format,
        sample_rate: config.sampleRate
      },
      model: config.model,
      speaker: config.voice
    }
  }
}

function mimeTypeForFormat(format: string): string {
  if (format === 'pcm') {
    return 'audio/pcm'
  }

  if (format === 'ogg_opus') {
    return 'audio/ogg'
  }

  if (format === 'wav') {
    return 'audio/wav'
  }

  return 'audio/mpeg'
}

async function expectEvent(
  queue: { next(): Promise<DecodedVolcengineTtsMessage> },
  expectedEvent: VolcengineTtsEventType,
  timeoutMs: number
): Promise<DecodedVolcengineTtsMessage> {
  const message = await withTimeout(queue.next(), timeoutMs)

  if (message.event !== expectedEvent) {
    throw new VolcengineTtsError(
      'STREAMING_TTS_UNEXPECTED_EVENT',
      `语音合成返回了非预期事件：${String(message.event)}`
    )
  }

  return message
}

async function collectAudioUntilSessionFinished(
  queue: { next(): Promise<DecodedVolcengineTtsMessage> },
  timeoutMs: number
): Promise<Buffer> {
  const chunks: Buffer[] = []

  while (true) {
    const message = await withTimeout(queue.next(), timeoutMs)

    if (
      message.messageType === VolcengineTtsMessageType.AudioOnlyServer &&
      message.event === VolcengineTtsEventType.TTSResponse
    ) {
      chunks.push(normalizeBuffer(message.payload as ArrayBuffer))
      continue
    }

    if (message.event === VolcengineTtsEventType.SessionFinished) {
      return Buffer.concat(chunks)
    }

    if (
      message.event === VolcengineTtsEventType.SessionFailed ||
      message.event === VolcengineTtsEventType.ConnectionFailed
    ) {
      throw new VolcengineTtsError('STREAMING_TTS_FAILED', '语音合成服务返回失败事件。')
    }
  }
}

export function createVolcengineTtsProvider(
  options: VolcengineTtsProviderOptions = {}
): StreamingTtsProvider {
  const env = options.env ?? process.env
  const randomUUID = options.randomUUID ?? nodeRandomUUID
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const webSocketFactory = options.webSocketFactory ?? createWsWebSocket

  return {
    async pushText(_payload: StreamingTtsPushPayload): Promise<StreamingTtsAudioChunk> {
      throw new VolcengineTtsError('STREAMING_TTS_NOT_IMPLEMENTED', '流式文本推送将在下一步接入。')
    },

    async speak(payload: TtsSpeakPayload): Promise<TtsSpeakResult> {
      const config = getConfig(env, payload.voice)
      const connectId = randomUUID()
      const sessionId = randomUUID()
      const socket = await withTimeout(
        Promise.resolve(webSocketFactory(config.endpoint, {
          headers: createHeaders(config, connectId)
        })),
        timeoutMs
      )
      socket.binaryType = 'arraybuffer'
      const queue = createMessageQueue(socket)
      const baseRequest = buildBaseRequest(config)

      await withTimeout(waitForOpen(socket), timeoutMs)
      sendEvent(socket, VolcengineTtsEventType.StartConnection, {})
      await expectEvent(queue, VolcengineTtsEventType.ConnectionStarted, timeoutMs)

      sendEvent(socket, VolcengineTtsEventType.StartSession, baseRequest, sessionId)
      await expectEvent(queue, VolcengineTtsEventType.SessionStarted, timeoutMs)

      sendEvent(
        socket,
        VolcengineTtsEventType.TaskRequest,
        {
          ...baseRequest,
          event: VolcengineTtsEventType.TaskRequest,
          req_params: {
            ...(baseRequest.req_params as Record<string, unknown>),
            text: payload.text
          }
        },
        sessionId
      )
      sendEvent(socket, VolcengineTtsEventType.FinishSession, {}, sessionId)

      const audio = await collectAudioUntilSessionFinished(queue, timeoutMs)

      sendEvent(socket, VolcengineTtsEventType.FinishConnection, {})
      await expectEvent(queue, VolcengineTtsEventType.ConnectionFinished, timeoutMs)
      socket.close()

      if (audio.byteLength === 0) {
        throw new VolcengineTtsError('STREAMING_TTS_EMPTY_AUDIO', '语音合成没有返回音频。')
      }

      return {
        audio: toArrayBuffer(audio),
        mimeType: mimeTypeForFormat(config.format)
      }
    },

    async start(_payload: StreamingTtsStartPayload): Promise<RealtimeAsrStartResult> {
      throw new VolcengineTtsError('STREAMING_TTS_NOT_IMPLEMENTED', '流式语音合成会话将在下一步接入。')
    },

    async stop(_payload: StreamingTtsStopPayload): Promise<StreamingTtsAudioChunk> {
      throw new VolcengineTtsError('STREAMING_TTS_NOT_IMPLEMENTED', '流式语音合成停止将在下一步接入。')
    }
  }
}
