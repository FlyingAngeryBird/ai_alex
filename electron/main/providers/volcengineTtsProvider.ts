import { randomUUID as nodeRandomUUID } from 'node:crypto'
import type {
  RealtimeAsrStartResult,
  StreamingTtsAudioChunk,
  StreamingTtsAudioHandler,
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

  type StreamSession = {
    socket: VolcengineTtsWebSocketLike
    onAudio: StreamingTtsAudioHandler
    config: VolcengineTtsConfig
    sessionId: string
    finished: boolean
    finishWaiters: Array<() => void>
    eventResolvers: Array<{
      event: VolcengineTtsEventType | number
      resolve: (message: DecodedVolcengineTtsMessage | undefined) => void
    }>
    error?: VolcengineTtsError
  }

  const sessions = new Map<string, StreamSession>()

  function wait(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      globalThis.setTimeout(resolve, timeoutMs)
    })
  }

  function resolveAll(session: StreamSession): void {
    for (const resolver of session.eventResolvers.splice(0)) {
      resolver.resolve(undefined)
    }

    for (const waiter of session.finishWaiters.splice(0)) {
      waiter()
    }
  }

  function handleStreamMessage(session: StreamSession, decoded: DecodedVolcengineTtsMessage): void {
    if (
      decoded.event === VolcengineTtsEventType.SessionFailed ||
      decoded.event === VolcengineTtsEventType.ConnectionFailed
    ) {
      session.error = new VolcengineTtsError('STREAMING_TTS_FAILED', '语音合成服务返回失败事件。')
      resolveAll(session)
      return
    }

    if (
      decoded.messageType === VolcengineTtsMessageType.AudioOnlyServer &&
      decoded.event === VolcengineTtsEventType.TTSResponse
    ) {
      session.onAudio({
        audio: toArrayBuffer(normalizeBuffer(decoded.payload as ArrayBuffer)),
        isFinal: false
      })
      return
    }

    if (decoded.event === VolcengineTtsEventType.SessionFinished) {
      session.finished = true
      session.onAudio({ audio: new ArrayBuffer(0), isFinal: true })
      resolveAll(session)
      return
    }

    for (let index = 0; index < session.eventResolvers.length; index += 1) {
      if (session.eventResolvers[index].event === decoded.event) {
        const resolver = session.eventResolvers.splice(index, 1)[0]
        resolver.resolve(decoded)
        return
      }
    }
  }

  function waitForEvent(
    session: StreamSession,
    event: VolcengineTtsEventType,
    timeoutMs: number
  ): Promise<void> {
    return withTimeout(
      new Promise<void>((resolve) => {
        session.eventResolvers.push({ event, resolve: () => resolve() })
      }),
      timeoutMs
    )
  }

  return {
    async pushText(payload: StreamingTtsPushPayload): Promise<void> {
      const session = sessions.get(payload.sessionId)

      if (!session) {
        throw new VolcengineTtsError('STREAMING_TTS_SESSION_NOT_FOUND', '流式语音合成会话不存在或已结束。')
      }

      if (session.error) {
        throw session.error
      }

      const baseRequest = buildBaseRequest(session.config)
      sendEvent(
        session.socket,
        VolcengineTtsEventType.TaskRequest,
        {
          ...baseRequest,
          event: VolcengineTtsEventType.TaskRequest,
          req_params: {
            ...(baseRequest.req_params as Record<string, unknown>),
            text: payload.text
          }
        },
        session.sessionId
      )
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

    async start(payload: StreamingTtsStartPayload): Promise<RealtimeAsrStartResult> {
      const config = getConfig(env, payload.voice)
      const sessionId = randomUUID()
      const connectId = randomUUID()
      const socket = await withTimeout(
        Promise.resolve(webSocketFactory(config.endpoint, { headers: createHeaders(config, connectId) })),
        timeoutMs
      )
      socket.binaryType = 'arraybuffer'

      const session: StreamSession = {
        socket,
        onAudio: payload.onAudio,
        config,
        sessionId,
        finished: false,
        finishWaiters: [],
        eventResolvers: []
      }
      sessions.set(sessionId, session)

      socket.addEventListener('message', (event) => {
        const data = (event as { data?: ArrayBuffer | Buffer | Uint8Array })?.data

        if (!data) {
          return
        }

        try {
          handleStreamMessage(session, decodeVolcengineTtsMessage(data))
        } catch (error) {
          session.error =
            error instanceof VolcengineTtsError
              ? error
              : new VolcengineTtsError('STREAMING_TTS_FAILED', '语音合成消息解析失败。')
          resolveAll(session)
        }
      })

      socket.addEventListener('error', () => {
        if (!session.error) {
          session.error = new VolcengineTtsError('STREAMING_TTS_CONNECT_FAILED', '语音合成连接异常。')
        }
        resolveAll(session)
      })

      await withTimeout(waitForOpen(socket), timeoutMs)
      sendEvent(socket, VolcengineTtsEventType.StartConnection, {})
      await waitForEvent(session, VolcengineTtsEventType.ConnectionStarted, timeoutMs)
      sendEvent(socket, VolcengineTtsEventType.StartSession, buildBaseRequest(config), sessionId)
      await waitForEvent(session, VolcengineTtsEventType.SessionStarted, timeoutMs)

      return { sessionId }
    },

    async stop(payload: StreamingTtsStopPayload): Promise<void> {
      const session = sessions.get(payload.sessionId)

      if (!session) {
        throw new VolcengineTtsError('STREAMING_TTS_SESSION_NOT_FOUND', '流式语音合成会话不存在或已结束。')
      }

      if (session.error) {
        sessions.delete(payload.sessionId)
        throw session.error
      }

      if (!session.finished) {
        sendEvent(session.socket, VolcengineTtsEventType.FinishSession, {}, session.sessionId)

        await Promise.race([
          new Promise<void>((resolve) => {
            session.finishWaiters.push(() => resolve())
          }),
          wait(timeoutMs)
        ])
      }

      sessions.delete(payload.sessionId)

      if (session.error) {
        throw session.error
      }

      try {
        sendEvent(session.socket, VolcengineTtsEventType.FinishConnection, {})
      } catch {
        // 连接已断开，忽略
      }

      try {
        session.socket.close()
      } catch {
        // 已关闭
      }
    }
  }
}
