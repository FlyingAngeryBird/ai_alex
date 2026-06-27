export type VoiceActivityEvent = 'speech_start' | 'speech_end'

export type VoiceActivityThresholds = {
  silenceMs: number
  speechEndLevel: number
  speechStartLevel: number
  speechStartMs: number
}

export const defaultVoiceActivityThresholds: VoiceActivityThresholds = {
  silenceMs: 900,
  speechEndLevel: 0.035,
  speechStartLevel: 0.08,
  speechStartMs: 160
}

export function createVoiceActivityDetector(
  thresholds: VoiceActivityThresholds = defaultVoiceActivityThresholds
) {
  let speaking = false
  let speechStartedAt: number | null = null
  let silenceStartedAt: number | null = null

  function reset() {
    speaking = false
    speechStartedAt = null
    silenceStartedAt = null
  }

  function push(level: number, nowMs: number): VoiceActivityEvent | null {
    if (!speaking) {
      if (level >= thresholds.speechStartLevel) {
        speechStartedAt ??= nowMs
        if (nowMs - speechStartedAt >= thresholds.speechStartMs) {
          speaking = true
          silenceStartedAt = null
          return 'speech_start'
        }
      } else {
        speechStartedAt = null
      }

      return null
    }

    if (level <= thresholds.speechEndLevel) {
      silenceStartedAt ??= nowMs
      if (nowMs - silenceStartedAt >= thresholds.silenceMs) {
        speaking = false
        speechStartedAt = null
        silenceStartedAt = null
        return 'speech_end'
      }
    } else {
      silenceStartedAt = null
    }

    return null
  }

  return {
    isSpeaking: () => speaking,
    push,
    reset
  }
}
