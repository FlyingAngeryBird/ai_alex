import { randomUUID } from 'node:crypto'
import type {
  AsrProvider,
  AudioTranscriptionPayload,
  AudioTranscriptionResult
} from '../ipc/voiceHandlers.js'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

type VolcengineAsrEnvironment = {
  VOLCENGINE_ASR_ACCESS_TOKEN?: string
  VOLCENGINE_ASR_APP_ID?: string
  VOLCENGINE_ASR_CLUSTER?: string
  VOLCENGINE_ASR_ENDPOINT?: string
  VOLCENGINE_ASR_MAX_QUERY_ATTEMPTS?: string
  VOLCENGINE_ASR_RESOURCE_ID?: string
  VOLCENGINE_ASR_UID?: string
}

type VolcengineAsrOptions = {
  env?: VolcengineAsrEnvironment
  fetch?: FetchLike
  requestId?: () => string
  sleep?: (ms: number) => Promise<void>
}

type VolcengineAsrConfig = {
  accessToken: string
  appId: string
  cluster: string
  endpoint: string
  maxQueryAttempts: number
  resourceId: string
  uid: string
}

type VolcengineAsrResponse = {
  message?: string
  result?: {
    text?: string
  }
}

const DEFAULT_ASR_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel'
const DEFAULT_CLUSTER = 'volcengine_input_common'
const DEFAULT_RESOURCE_ID = 'volc.seedasr.auc'
const DEFAULT_UID = 'lingli-desktop'

export class VolcengineAsrError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'VolcengineAsrError'
  }
}

function getEnvironment(options: VolcengineAsrOptions): VolcengineAsrEnvironment {
  return options.env ?? process.env
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/$/, '')
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getConfig(options: VolcengineAsrOptions): VolcengineAsrConfig {
  const env = getEnvironment(options)

  if (!env.VOLCENGINE_ASR_APP_ID || !env.VOLCENGINE_ASR_ACCESS_TOKEN) {
    throw new VolcengineAsrError('ASR_NOT_CONFIGURED', '语音识别还没有配置火山引擎密钥。')
  }

  return {
    accessToken: env.VOLCENGINE_ASR_ACCESS_TOKEN,
    appId: env.VOLCENGINE_ASR_APP_ID,
    cluster: env.VOLCENGINE_ASR_CLUSTER ?? DEFAULT_CLUSTER,
    endpoint: normalizeEndpoint(env.VOLCENGINE_ASR_ENDPOINT ?? DEFAULT_ASR_ENDPOINT),
    maxQueryAttempts: parsePositiveInteger(env.VOLCENGINE_ASR_MAX_QUERY_ATTEMPTS, 10),
    resourceId: env.VOLCENGINE_ASR_RESOURCE_ID ?? DEFAULT_RESOURCE_ID,
    uid: env.VOLCENGINE_ASR_UID ?? DEFAULT_UID
  }
}

function getAudioFormat(mimeType: string): string {
  const cleanMime = mimeType.split(';')[0]?.trim().toLowerCase()
  const subtype = cleanMime?.split('/')[1]

  return subtype || 'webm'
}

function encodeAudio(audio: ArrayBuffer): string {
  return Buffer.from(audio).toString('base64')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms)
  })
}

async function parseResponse(response: Response): Promise<VolcengineAsrResponse> {
  const text = await response.text()

  if (!text.trim()) {
    return {}
  }

  return JSON.parse(text) as VolcengineAsrResponse
}

function assertSuccessfulResponse(response: Response, body: VolcengineAsrResponse): void {
  const apiStatus = response.headers.get('X-Api-Status-Code')
  const apiMessage = response.headers.get('X-Api-Message')

  if (!response.ok || (apiStatus && apiStatus !== '20000000')) {
    throw new VolcengineAsrError(
      'ASR_FAILED',
      apiMessage || body.message || '语音识别请求失败'
    )
  }
}

function createHeaders(config: VolcengineAsrConfig, requestId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Api-Access-Key': config.accessToken,
    'X-Api-App-Key': config.appId,
    'X-Api-Request-Id': requestId,
    'X-Api-Resource-Id': config.resourceId
  }
}

function createSubmitBody(
  config: VolcengineAsrConfig,
  payload: AudioTranscriptionPayload
): Record<string, unknown> {
  return {
    app: {
      cluster: config.cluster,
      token: config.accessToken,
      uid: config.uid
    },
    audio: {
      data: encodeAudio(payload.audio),
      format: getAudioFormat(payload.mimeType)
    },
    request: {
      enable_itn: true,
      enable_punc: true,
      show_utterances: false
    }
  }
}

export function createVolcengineAsrProvider(options: VolcengineAsrOptions = {}): AsrProvider {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const createRequestId = options.requestId ?? randomUUID
  const wait = options.sleep ?? sleep

  async function transcribe(
    payload: AudioTranscriptionPayload
  ): Promise<AudioTranscriptionResult> {
    const config = getConfig(options)
    const requestId = createRequestId()
    const headers = createHeaders(config, requestId)
    const submitResponse = await fetcher(`${config.endpoint}/submit`, {
      body: JSON.stringify(createSubmitBody(config, payload)),
      headers,
      method: 'POST'
    })
    const submitBody = await parseResponse(submitResponse)

    assertSuccessfulResponse(submitResponse, submitBody)

    for (let attempt = 0; attempt < config.maxQueryAttempts; attempt += 1) {
      if (attempt > 0) {
        await wait(800)
      }

      const queryResponse = await fetcher(`${config.endpoint}/query`, {
        body: JSON.stringify({}),
        headers,
        method: 'POST'
      })
      const queryBody = await parseResponse(queryResponse)

      assertSuccessfulResponse(queryResponse, queryBody)

      const text = queryBody.result?.text?.trim()
      if (text) {
        return {
          text
        }
      }
    }

    throw new VolcengineAsrError('ASR_TIMEOUT', '语音识别结果等待超时。')
  }

  return {
    transcribe
  }
}
