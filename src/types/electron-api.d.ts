export type AppError = {
  code: string
  message: string
  details?: unknown
}

export type AppResult<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: AppError
    }

export type LingliChannel =
  | 'app.getRuntimeState'
  | 'chat.sendMessage'
  | 'music.authorize'
  | 'music.getPlaybackState'
  | 'music.pause'
  | 'music.play'
  | 'music.resume'
  | 'music.search'
  | 'tts.speak'
  | 'tts.startStreaming'
  | 'tts.pushText'
  | 'tts.stopStreaming'
  | 'voice.startRecording'
  | 'voice.startRealtime'
  | 'voice.pushRealtimeAudio'
  | 'voice.stopRealtime'
  | 'voice.stopAndTranscribe'

declare global {
  interface Window {
    lingli: {
      invoke<T>(channel: LingliChannel, payload?: unknown): Promise<AppResult<T>>
    }
  }
}
