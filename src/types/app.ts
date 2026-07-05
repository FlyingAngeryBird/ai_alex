export type ParticleState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'playing'
  | 'error'

export type ViewMode = 'conversation' | 'music'

export type VoiceInputMode = 'push_to_talk' | 'auto_listen'

export type MusicSource = 'netease' | 'kuwo' | 'joox'

export type MusicSourcePreference = 'all' | MusicSource

export type LyricLine = {
  timeMs: number
  text: string
}

export type MusicAudioBands = {
  bass: number
  beat?: number
  centroid?: number
  flux?: number
  mid: number
  treble: number
}

export type AutoListenState =
  | 'off'
  | 'arming'
  | 'armed'
  | 'prehearing'
  | 'recording'
  | 'grace'
  | 'speech_detected'
  | 'finalizing'
  | 'paused_for_tts'
  | 'error'

export type UiMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  createdAt: number
  state?: ParticleState
}

export type MusicTrack = {
  id: string
  playbackId?: string
  lyricId?: string
  artworkId?: string
  source?: MusicSource
  title: string
  artist: string
  album?: string
  artworkUrl?: string
  audioUrl?: string
  durationMs: number
  lyrics?: LyricLine[]
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
  music?: {
    keyword: string
  } | null
  reply?: string
  text: string
}
