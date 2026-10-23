export type VoiceActivityEvent = 'speech_start' | 'speech_end'

export type VoiceActivityThresholds = {
  adaptiveNoise?: boolean
  noiseFloorAlpha?: number
  noiseFloorMargin?: number
  silenceMs: number
  speechEndLevel: number
  speechStartLevel: number
  speechStartMs: number
}

export type VoiceActivityDiagnostics = {
  noiseFloor: number | null
  speaking: boolean
  speechEndLevel: number
  speechStartLevel: number
}

export const defaultVoiceActivityThresholds: VoiceActivityThresholds = {
  adaptiveNoise: true,
  noiseFloorAlpha: 0.12,
  noiseFloorMargin: 0.04,
  silenceMs: 900,
  speechEndLevel: 0.035,
  speechStartLevel: 0.08,
  speechStartMs: 160
}

export function createVoiceActivityDetector(
  thresholds: VoiceActivityThresholds = defaultVoiceActivityThresholds
) {
  const adaptiveNoise = thresholds.adaptiveNoise ?? false
  const noiseFloorAlpha = thresholds.noiseFloorAlpha ?? defaultVoiceActivityThresholds.noiseFloorAlpha ?? 0.12
  const noiseFloorMargin = thresholds.noiseFloorMargin ?? defaultVoiceActivityThresholds.noiseFloorMargin ?? 0.04
  let noiseFloor: number | null = null
  let speaking = false
  let speechStartedAt: number | null = null
  let silenceStartedAt: number | null = null

  function getEffectiveThresholds(): Pick<VoiceActivityThresholds, 'speechEndLevel' | 'speechStartLevel'> {
    if (!adaptiveNoise || noiseFloor === null) {
      return {
        speechEndLevel: thresholds.speechEndLevel,
        speechStartLevel: thresholds.speechStartLevel
      }
    }

    const adaptiveStart = noiseFloor + noiseFloorMargin

    return {
      speechEndLevel: Math.max(thresholds.speechEndLevel, noiseFloor + noiseFloorMargin * 0.48),
      speechStartLevel: Math.max(thresholds.speechStartLevel, adaptiveStart)
    }
  }

  function getDiagnostics(): VoiceActivityDiagnostics {
    const effectiveThresholds = getEffectiveThresholds()

    return {
      noiseFloor,
      speaking,
      speechEndLevel: effectiveThresholds.speechEndLevel,
      speechStartLevel: effectiveThresholds.speechStartLevel
    }
  }

  function updateNoiseFloor(level: number): void {
    if (!adaptiveNoise || speaking) {
      return
    }

    noiseFloor = noiseFloor === null
      ? level
      : noiseFloor + (level - noiseFloor) * noiseFloorAlpha
  }

  function reset() {
    noiseFloor = null
    speaking = false
    speechStartedAt = null
    silenceStartedAt = null
  }

  function push(level: number, nowMs: number): VoiceActivityEvent | null {
    updateNoiseFloor(level)
    const effectiveThresholds = getEffectiveThresholds()

    if (!speaking) {
      if (level >= effectiveThresholds.speechStartLevel) {
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

    if (level <= effectiveThresholds.speechEndLevel) {
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
    getDiagnostics,
    getThresholds: getEffectiveThresholds,
    isSpeaking: () => speaking,
    push,
    reset
  }
}
