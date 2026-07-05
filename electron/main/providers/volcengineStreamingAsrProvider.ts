import { randomUUID as nodeRandomUUID } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import type {
  RealtimeAsrPushPayload,
  RealtimeAsrPushResult,
  RealtimeAsrStartPayload,
  RealtimeAsrStartResult,
  RealtimeAsrStopPayload,
  RealtimeAsrStopResult,
  StreamingAsrProvider
} from './realtimeVoiceProvider.js'

const DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async'
const DEFAULT_RESOURCE_ID = 'volc.bigasr.sauc.duration'
const DEFAULT_SAMPLE_RATE = 16000
const DEFAULT_UID = 'lingmo'

const PROTOCOL_VERSION = 0b0001
const HEADER_SIZE = 0b0001
const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0b0001
const MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 0b0010
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 0b1001
const MESSAGE_TYPE_ERROR = 0b1111
const FLAG_NONE = 0b0000
const FLAG_FINAL_PACKET = 0b0010
const SERIALIZATION_NONE = 0b0000
const SERIALIZATION_JSON = 0b0001
const COMPRESSION_NONE = 0b0000
const COMPRESSION_GZIP = 0b0001
const DEFAULT_TIMEOUT_MS = 12000
const MALFORMED_RESPONSE_MESSAGE = '实时语音识别服务返回了无法解析的数据，请稍后再试。'

type Env = Record<string, string | undefined>

export type VolcengineWebSocketLike = {
  addEventListener(event: string, listener: (event?: unknown) => void): void
  binaryType?: string
  close(): void
  send(data: ArrayBuffer | Buffer): void
}

export type VolcengineWebSocketFactoryOptions = {
  headers: Record<string, string>
}

export type VolcengineWebSocketFactory = (
  url: string,
  options: VolcengineWebSocketFactoryOptions
) => Promise<VolcengineWebSocketLike> | VolcengineWebSocketLike

type VolcengineStreamingAsrProviderOptions = {
  env?: Env
  randomUUID?: () => string
  timeoutMs?: number
  webSocketFactory?: VolcengineWebSocketFactory
}

type VolcengineAsrSession = {
  error?: VolcengineStreamingAsrError
  latestText: string
  socket: VolcengineWebSocketLike
  textWaiters: Array<(text: string) => void>
}

type VolcengineAsrRequest = {
  audio: {
    channel?: number
    codec?: string
    format: string
    language?: string
    rate: number
  }
  request: Record<string, unknown>
  user: {
    uid: string
  }
}

export type DecodedVolcengineAsrResponse = {
  event?: number
  flags: number
  messageType: number
  payload: unknown
  requestId?: string
  sequence?: number
}

export class VolcengineStreamingAsrError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'VolcengineStreamingAsrError'
  }
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return Uint8Array.from(buffer).buffer
}

function readEnv(env: Env, key: string): string {
  return env[key]?.trim() ?? ''
}

function createHeader(messageType: number, flags: number, serialization: number, compression: number): Buffer {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00
  ])
}

function createFrame(
  messageType: number,
  flags: number,
  serialization: number,
  compression: number,
  payload: Buffer
): ArrayBuffer {
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.byteLength, 0)

  return toArrayBuffer(Buffer.concat([createHeader(messageType, flags, serialization, compression), size, payload]))
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

function decodePayload(
  compressedPayload: Buffer,
  serialization: number,
  compression: number
): unknown {
  let rawPayload: Buffer

  try {
    rawPayload = compression === COMPRESSION_GZIP ? gunzipSync(compressedPayload) : compressedPayload
  } catch {
    throw new VolcengineStreamingAsrError('REALTIME_ASR_SERVER_ERROR', MALFORMED_RESPONSE_MESSAGE)
  }

  if (serialization !== SERIALIZATION_JSON) {
    return toArrayBuffer(rawPayload)
  }

  try {
    return JSON.parse(rawPayload.toString('utf8'))
  } catch {
    throw new VolcengineStreamingAsrError('REALTIME_ASR_SERVER_ERROR', MALFORMED_RESPONSE_MESSAGE)
  }
}

function hasSequence(flags: number): boolean {
  return flags === 0b0001 || flags === 0b0011
}

function looksLikeTextIdentifier(value: Buffer): boolean {
  return value.length > 0 && value.every((byte) => byte >= 0x20 && byte <= 0x7e)
}

function extractText(payload: unknown): string {
  const value = payload as {
    result?: {
      text?: unknown
    }
    text?: unknown
  }

  if (typeof value?.result?.text === 'string') {
    return value.result.text
  }

  if (typeof value?.text === 'string') {
    return value.text
  }

  return ''
}

function buildDefaultRequest(payload: RealtimeAsrStartPayload, uid: string): VolcengineAsrRequest {
  return {
    audio: {
      channel: 1,
      codec: 'raw',
      format: 'pcm',
      language: 'zh-CN',
      rate: payload.sampleRate ?? DEFAULT_SAMPLE_RATE
    },
    request: {
      enable_itn: true,
      enable_punc: true,
      model_name: 'bigmodel',
      show_utterances: false
    },
    user: {
      uid
    }
  }
}

function resolveHeaders(env: Env, connectId: string): Record<string, string> {
  const resourceId = readEnv(env, 'VOLCENGINE_STREAM_ASR_RESOURCE_ID') || DEFAULT_RESOURCE_ID
  const apiKey = readEnv(env, 'VOLCENGINE_STREAM_ASR_API_KEY')
  const appId = readEnv(env, 'VOLCENGINE_ASR_APP_ID')
  const accessToken = readEnv(env, 'VOLCENGINE_ASR_ACCESS_TOKEN')

  if (apiKey) {
    return {
      'X-Api-Connect-Id': connectId,
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId
    }
  }

  if (appId && accessToken) {
    return {
      'X-Api-Access-Key': accessToken,
      'X-Api-App-Key': appId,
      'X-Api-Connect-Id': connectId,
      'X-Api-Resource-Id': resourceId
    }
  }

  throw new VolcengineStreamingAsrError(
    'REALTIME_ASR_NOT_CONFIGURED',
    '实时语音识别还没有配置火山引擎 API Key 或 APP ID/Access Token。'
  )
}

async function createWsWebSocket(
  url: string,
  options: VolcengineWebSocketFactoryOptions
): Promise<VolcengineWebSocketLike> {
  const wsModule = await import('ws')
  const Socket = wsModule.WebSocket

  return new Socket(url, {
    headers: options.headers
  }) as unknown as VolcengineWebSocketLike
}

function waitForOpen(socket: VolcengineWebSocketLike): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', (event) => {
      reject(
        new VolcengineStreamingAsrError(
          'REALTIME_ASR_CONNECT_FAILED',
          event instanceof Error ? event.message : '实时语音识别连接失败'
        )
      )
    })
  })
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms)
  })
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  code: string,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => {
      reject(new VolcengineStreamingAsrError(code, message))
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer)
    }
  })
}

export function buildVolcengineAsrFullClientRequest(request: VolcengineAsrRequest): ArrayBuffer {
  const payload = gzipSync(Buffer.from(JSON.stringify(request)))

  return createFrame(
    MESSAGE_TYPE_FULL_CLIENT_REQUEST,
    FLAG_NONE,
    SERIALIZATION_JSON,
    COMPRESSION_GZIP,
    payload
  )
}

export function buildVolcengineAsrAudioRequest(audio: ArrayBuffer, isFinal = false): ArrayBuffer {
  const payload = gzipSync(normalizeBuffer(audio))

  return createFrame(
    MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
    isFinal ? FLAG_FINAL_PACKET : FLAG_NONE,
    SERIALIZATION_NONE,
    COMPRESSION_GZIP,
    payload
  )
}

export function decodeVolcengineAsrResponse(data: ArrayBuffer | Buffer | Uint8Array): DecodedVolcengineAsrResponse {
  const message = normalizeBuffer(data)
  const headerSize = (message[0] & 0x0f) * 4
  const messageType = message[1] >> 4
  const flags = message[1] & 0x0f
  const serialization = message[2] >> 4
  const compression = message[2] & 0x0f
  let event: number | undefined
  let offset = headerSize
  let requestId: string | undefined
  let sequence: number | undefined

  if (hasSequence(flags)) {
    sequence = message.readInt32BE(offset)
    offset += 4
  }

  if (flags === 0b0100 && messageType === MESSAGE_TYPE_FULL_SERVER_RESPONSE) {
    event = message.readUInt32BE(offset)
    offset += 4

    const possibleRequestIdSize = message.readUInt32BE(offset)
    const requestIdStart = offset + 4
    const requestIdEnd = requestIdStart + possibleRequestIdSize

    if (
      possibleRequestIdSize > 0 &&
      requestIdEnd + 4 <= message.length &&
      looksLikeTextIdentifier(message.subarray(requestIdStart, requestIdEnd))
    ) {
      requestId = message.subarray(requestIdStart, requestIdEnd).toString('utf8')
      offset = requestIdEnd
    }
  }

  const payloadSize = message.readUInt32BE(offset)
  offset += 4

  const compressedPayload = message.subarray(offset, offset + payloadSize)
  const payload = decodePayload(compressedPayload, serialization, compression)

  if (messageType === MESSAGE_TYPE_ERROR) {
    throw new VolcengineStreamingAsrError(
      'REALTIME_ASR_SERVER_ERROR',
      typeof payload === 'object' ? JSON.stringify(payload) : '实时语音识别服务返回错误'
    )
  }

  return {
    event,
    flags,
    messageType,
    payload,
    requestId,
    sequence
  }
}

export function createVolcengineStreamingAsrProvider(
  options: VolcengineStreamingAsrProviderOptions = {}
): StreamingAsrProvider {
  const env = options.env ?? process.env
  const randomUUID = options.randomUUID ?? nodeRandomUUID
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const webSocketFactory = options.webSocketFactory ?? createWsWebSocket
  const sessions = new Map<string, VolcengineAsrSession>()

  function getSession(sessionId: string): VolcengineAsrSession {
    const session = sessions.get(sessionId)

    if (!session) {
      throw new VolcengineStreamingAsrError('REALTIME_ASR_SESSION_NOT_FOUND', '实时语音识别会话不存在或已结束。')
    }

    return session
  }

  return {
    async pushAudio(payload: RealtimeAsrPushPayload): Promise<RealtimeAsrPushResult> {
      const session = getSession(payload.sessionId)

      session.socket.send(buildVolcengineAsrAudioRequest(payload.audio))

      return {
        partialText: session.latestText || undefined
      }
    },

    async start(payload: RealtimeAsrStartPayload): Promise<RealtimeAsrStartResult> {
      const sessionId = randomUUID()
      const endpoint = readEnv(env, 'VOLCENGINE_STREAM_ASR_ENDPOINT') || DEFAULT_ENDPOINT
      const headers = resolveHeaders(env, sessionId)
      const uid = readEnv(env, 'VOLCENGINE_STREAM_ASR_UID') || DEFAULT_UID
      const socket = await withTimeout(
        Promise.resolve(webSocketFactory(endpoint, { headers })),
        timeoutMs,
        'REALTIME_ASR_TIMEOUT',
        '实时语音识别连接超时。'
      )

      socket.binaryType = 'arraybuffer'
      socket.addEventListener('message', (event) => {
        try {
          const data = (event as { data?: ArrayBuffer | Buffer | Uint8Array })?.data

          if (!data) {
            return
          }

          const decoded = decodeVolcengineAsrResponse(data)

          if (decoded.messageType === MESSAGE_TYPE_FULL_SERVER_RESPONSE) {
            const text = extractText(decoded.payload)

            if (text) {
              const session = sessions.get(sessionId)

              if (session) {
                session.latestText = text
                for (const waiter of session.textWaiters.splice(0)) {
                  waiter(text)
                }
              }
            }
          }
        } catch (error) {
          const session = sessions.get(sessionId)
          const asrError = error instanceof VolcengineStreamingAsrError
            ? error
            : new VolcengineStreamingAsrError(
                'REALTIME_ASR_SERVER_ERROR',
                MALFORMED_RESPONSE_MESSAGE
              )

          if (session) {
            session.error = asrError
            for (const waiter of session.textWaiters.splice(0)) {
              waiter('')
            }
          }
        }
      })

      await withTimeout(
        waitForOpen(socket),
        timeoutMs,
        'REALTIME_ASR_TIMEOUT',
        '实时语音识别连接超时。'
      )
      sessions.set(sessionId, {
        latestText: '',
        socket,
        textWaiters: []
      })
      socket.send(buildVolcengineAsrFullClientRequest(buildDefaultRequest(payload, uid)))

      return {
        sessionId
      }
    },

    async stop(payload: RealtimeAsrStopPayload): Promise<RealtimeAsrStopResult> {
      const session = getSession(payload.sessionId)

      if (session.error) {
        session.socket.close()
        sessions.delete(payload.sessionId)
        throw session.error
      }

      session.socket.send(buildVolcengineAsrAudioRequest(new ArrayBuffer(0), true))
      if (!session.latestText) {
        await Promise.race([
          new Promise((resolve) => {
            session.textWaiters.push(resolve)
          }),
          wait(1400)
        ])
      }
      if (session.error) {
        session.socket.close()
        sessions.delete(payload.sessionId)
        throw session.error
      }
      session.socket.close()
      sessions.delete(payload.sessionId)

      return {
        text: session.latestText
      }
    }
  }
}
