import { describe, expect, it } from 'vitest'
import { createVoiceActivityDetector } from '../src/services/voiceActivity'

describe('voice activity detector', () => {
  it('starts after sustained speech and ends after sustained silence', () => {
    const detector = createVoiceActivityDetector({
      silenceMs: 900,
      speechEndLevel: 0.035,
      speechStartLevel: 0.08,
      speechStartMs: 160
    })

    expect(detector.push(0.02, 0)).toBeNull()
    expect(detector.push(0.1, 100)).toBeNull()
    expect(detector.push(0.11, 260)).toBe('speech_start')
    expect(detector.push(0.09, 500)).toBeNull()
    expect(detector.push(0.02, 900)).toBeNull()
    expect(detector.push(0.02, 1800)).toBe('speech_end')
  })

  it('does not start on a short noise spike', () => {
    const detector = createVoiceActivityDetector({
      silenceMs: 900,
      speechEndLevel: 0.035,
      speechStartLevel: 0.08,
      speechStartMs: 160
    })

    expect(detector.push(0.11, 0)).toBeNull()
    expect(detector.push(0.02, 80)).toBeNull()
    expect(detector.isSpeaking()).toBe(false)
  })
})
