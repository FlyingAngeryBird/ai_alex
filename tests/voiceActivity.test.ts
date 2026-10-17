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

  it('adapts to sustained room noise without treating it as speech', () => {
    const detector = createVoiceActivityDetector({
      adaptiveNoise: true,
      silenceMs: 900,
      speechEndLevel: 0.035,
      speechStartLevel: 0.08,
      speechStartMs: 160
    })

    for (let time = 0; time <= 1000; time += 100) {
      expect(detector.push(0.09, time)).toBeNull()
    }

    expect(detector.isSpeaking()).toBe(false)
    expect(detector.getThresholds().speechStartLevel).toBeGreaterThan(0.11)
  })

  it('still starts when speech rises above the calibrated noise floor', () => {
    const detector = createVoiceActivityDetector({
      adaptiveNoise: true,
      silenceMs: 900,
      speechEndLevel: 0.035,
      speechStartLevel: 0.08,
      speechStartMs: 160
    })

    for (let time = 0; time <= 1000; time += 100) {
      detector.push(0.09, time)
    }

    expect(detector.push(0.16, 1200)).toBeNull()
    expect(detector.push(0.17, 1400)).toBe('speech_start')
  })

  it('lowers the adaptive floor again after the room gets quiet', () => {
    const detector = createVoiceActivityDetector({
      adaptiveNoise: true,
      silenceMs: 900,
      speechEndLevel: 0.035,
      speechStartLevel: 0.08,
      speechStartMs: 160
    })

    for (let time = 0; time <= 1000; time += 100) {
      detector.push(0.09, time)
    }

    const noisyStart = detector.getThresholds().speechStartLevel

    for (let time = 1200; time <= 3000; time += 100) {
      detector.push(0.02, time)
    }

    expect(detector.getThresholds().speechStartLevel).toBeLessThan(noisyStart)
    expect(detector.push(0.1, 3200)).toBeNull()
    expect(detector.push(0.11, 3400)).toBe('speech_start')
  })

  it('exposes diagnostics for tuning automatic listening in real rooms', () => {
    const detector = createVoiceActivityDetector({
      adaptiveNoise: true,
      silenceMs: 900,
      speechEndLevel: 0.035,
      speechStartLevel: 0.08,
      speechStartMs: 160
    })

    detector.push(0.06, 0)
    detector.push(0.07, 100)

    expect(detector.getDiagnostics()).toMatchObject({
      noiseFloor: expect.any(Number),
      speaking: false
    })
    expect(detector.getDiagnostics().speechStartLevel).toBeGreaterThanOrEqual(0.08)
    expect(detector.getDiagnostics().speechEndLevel).toBeGreaterThanOrEqual(0.035)
  })
})
