export type RealtimeAsrStartPayload = {
  sampleRate?: number
}

export type RealtimeAsrPushPayload = {
  audio: ArrayBuffer
  sessionId: string
}

export type RealtimeAsrStopPayload = {
  sessionId: string
}

export type RealtimeAsrStartResult = {
  sessionId: string
}

export type RealtimeAsrPushResult = {
  partialText?: string
}

export type RealtimeAsrStopResult = {
  text: string
}

export type StreamingAsrProvider = {
  pushAudio(payload: RealtimeAsrPushPayload): Promise<RealtimeAsrPushResult>
  start(payload: RealtimeAsrStartPayload): Promise<RealtimeAsrStartResult>
  stop(payload: RealtimeAsrStopPayload): Promise<RealtimeAsrStopResult>
}

export type StreamingTtsStartPayload = {
  voice?: string
}

export type StreamingTtsPushPayload = {
  sessionId: string
  text: string
}

export type StreamingTtsStopPayload = {
  sessionId: string
}

export type StreamingTtsAudioChunk = {
  audio: ArrayBuffer
  isFinal: boolean
}

export type TtsSpeakPayload = {
  text: string
  voice?: string
}

export type TtsSpeakResult = {
  audio: ArrayBuffer
  mimeType: string
}

export type StreamingTtsProvider = {
  pushText(payload: StreamingTtsPushPayload): Promise<StreamingTtsAudioChunk>
  speak(payload: TtsSpeakPayload): Promise<TtsSpeakResult>
  start(payload: StreamingTtsStartPayload): Promise<RealtimeAsrStartResult>
  stop(payload: StreamingTtsStopPayload): Promise<StreamingTtsAudioChunk>
}

export class RealtimeVoiceError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'RealtimeVoiceError'
  }
}

export function createUnavailableStreamingAsrProvider(): StreamingAsrProvider {
  async function unavailable(): Promise<never> {
    throw new RealtimeVoiceError(
      'REALTIME_ASR_NOT_CONFIGURED',
      '流式语音识别 2.0 还没有完成火山引擎配置。'
    )
  }

  return {
    pushAudio: unavailable,
    start: unavailable,
    stop: unavailable
  }
}

export function createUnavailableStreamingTtsProvider(): StreamingTtsProvider {
  async function unavailable(): Promise<never> {
    throw new RealtimeVoiceError(
      'STREAMING_TTS_NOT_CONFIGURED',
      '语音合成 2.0 还没有完成火山引擎配置。'
    )
  }

  return {
    pushText: unavailable,
    speak: unavailable,
    start: unavailable,
    stop: unavailable
  }
}
