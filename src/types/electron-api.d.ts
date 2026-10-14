export type AppError = {
  code: string
  message: string
  details?: unknown
}

import type { R1Api } from '../../electron/shared/r1Api'

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
  | 'chat.greeting'
  | 'chat.streamMessage'
  | 'chat.setTemporary'
  | 'chat.stopResponse'
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
  | 'r1.items.list'
  | 'r1.persona.get'
  | 'r1.persona.update'
  | 'r1.items.create'
  | 'r1.items.complete'
  | 'r1.items.deletionPreview'
  | 'r1.items.delete'
  | 'r1.reminders.list'
  | 'r1.reminders.create'
  | 'r1.reminders.reschedule'
  | 'r1.reminders.cancel'
  | 'r1.credentials.status'
  | 'r1.credentials.save'
  | 'r1.search.web'
  | 'r1.search.open'
  | 'tts.speak'
  | 'tts.startStreaming'
  | 'tts.pushText'
  | 'tts.stopStreaming'
  | 'voice.nativeStart'
  | 'voice.nativePlayback'
  | 'voice.nativeAudio'
  | 'voice.nativeMute'
  | 'voice.nativeCancel'
  | 'voice.nativeStop'
  | 'voice.startRecording'
  | 'voice.startRealtime'
  | 'voice.pushRealtimeAudio'
  | 'voice.stopRealtime'
  | 'voice.stopAndTranscribe'

export type LingliEventChannel = 'voice.nativeEvent' | 'chat.streamChunk' | 'tts.streamAudio' | 'r1.reminderDue'

declare global {
  interface Window {
    seamoR1: R1Api
    lingli: {
      invoke<T>(channel: LingliChannel, payload?: unknown): Promise<AppResult<T>>
      on<T>(channel: LingliEventChannel, handler: (payload: T) => void): () => void
    }
  }
}
