export type ParticleState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'playing'
  | 'error'

export type ViewMode = 'conversation' | 'music'

export type UiMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: number
  state?: ParticleState
}

export type MusicTrack = {
  id: string
  title: string
  artist: string
  album?: string
  artworkUrl?: string
  durationMs: number
  lyrics?: string[]
  recommendation?: string
}

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export type PlaybackState = {
  status: PlaybackStatus
  track: MusicTrack | null
  positionMs: number
  durationMs: number | null
  errorMessage?: string
}

export type ChatIntent = 'chat' | 'play_music'

export type ConversationResult = {
  intent: ChatIntent
  text: string
}
