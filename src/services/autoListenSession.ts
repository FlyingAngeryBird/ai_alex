import type { AutoListenState } from '@/types/app'

export type AutoListenSessionBlockers = {
  assistantSpeaking: boolean
  manualVoiceActive: boolean
  musicActive: boolean
}

export type AutoListenSessionOptions = {
  graceMs?: number
}

const DEFAULT_GRACE_MS = 1100

export function createAutoListenSession(options: AutoListenSessionOptions = {}) {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  let currentState: AutoListenState = 'off'
  let graceDeadlineMs: number | null = null

  function clearGrace(): void {
    graceDeadlineMs = null
  }

  function state(): AutoListenState {
    return currentState
  }

  function setState(nextState: AutoListenState): AutoListenState {
    currentState = nextState
    if (nextState !== 'grace') {
      clearGrace()
    }

    return currentState
  }

  function enable(): AutoListenState {
    return setState('arming')
  }

  function ready(): AutoListenState {
    return setState('armed')
  }

  function disable(): AutoListenState {
    return setState('off')
  }

  function speechStart(): AutoListenState {
    if (currentState === 'armed') {
      return setState('prehearing')
    }

    if (currentState === 'grace') {
      return setState('recording')
    }

    return currentState
  }

  function recording(): AutoListenState {
    if (currentState === 'prehearing' || currentState === 'armed') {
      return setState('recording')
    }

    return currentState
  }

  function speechEnd(nowMs = performance.now()): AutoListenState {
    if (currentState !== 'recording') {
      return currentState
    }

    currentState = 'grace'
    graceDeadlineMs = nowMs + graceMs
    return currentState
  }

  function graceExpired(nowMs = performance.now()): AutoListenState {
    if (currentState !== 'grace' || graceDeadlineMs === null || nowMs < graceDeadlineMs) {
      return currentState
    }

    return setState('finalizing')
  }

  function pauseForAssistant(): AutoListenState {
    return setState('paused_for_tts')
  }

  function fail(): AutoListenState {
    return setState('error')
  }

  function canDetect(blockers: AutoListenSessionBlockers): boolean {
    if (blockers.assistantSpeaking || blockers.manualVoiceActive || blockers.musicActive) {
      return false
    }

    return currentState === 'armed' || currentState === 'prehearing' || currentState === 'recording' || currentState === 'grace'
  }

  return {
    canDetect,
    disable,
    enable,
    fail,
    graceExpired,
    pauseForAssistant,
    ready,
    recording,
    speechEnd,
    speechStart,
    state
  }
}
