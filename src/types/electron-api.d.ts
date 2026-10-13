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
  | 'app.requestMicrophoneAccess'
  | 'chat.sendMessage'
  | 'chat.streamMessage'
  | 'config.get'
  | 'config.update'
  | 'music.addSearchHistory'
  | 'music.authorize'
  | 'music.clearSearchHistory'
  | 'music.getLibrary'
  | 'music.getPlaybackState'
  | 'music.pause'
  | 'music.play'
  | 'music.resume'
  | 'music.search'
  | 'music.toggleFavorite'
  | 'tts.speak'
  | 'tts.startStreaming'
  | 'tts.pushText'
  | 'tts.stopStreaming'
  | 'voice.startRecording'
  | 'voice.startRealtime'
  | 'voice.pushRealtimeAudio'
  | 'voice.stopRealtime'
  | 'voice.stopAndTranscribe'

export type LingliEventChannel = 'chat.streamChunk' | 'tts.streamAudio'

declare global {
  interface Window {
    lingli: {
      invoke<T>(channel: LingliChannel, payload?: unknown): Promise<AppResult<T>>
      on<T>(channel: LingliEventChannel, handler: (payload: T) => void): () => void
    }
  }
}
