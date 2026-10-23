import { describe, expect, it } from 'vitest'
import { createAutoListenSession } from '../src/services/autoListenSession'

describe('auto listen session', () => {
  it('moves through a human conversation turn with a grace window before finalizing', () => {
    const session = createAutoListenSession({ graceMs: 1000 })

    expect(session.state()).toBe('off')
    expect(session.enable()).toBe('arming')
    expect(session.ready()).toBe('armed')
    expect(session.speechStart()).toBe('prehearing')
    expect(session.recording()).toBe('recording')
    expect(session.speechEnd(2000)).toBe('grace')
    expect(session.graceExpired(2600)).toBe('grace')
    expect(session.graceExpired(3000)).toBe('finalizing')
    expect(session.pauseForAssistant()).toBe('paused_for_tts')
    expect(session.ready()).toBe('armed')
  })

  it('resumes the same recording when the user continues during the grace window', () => {
    const session = createAutoListenSession({ graceMs: 1000 })

    session.enable()
    session.ready()
    session.speechStart()
    session.recording()
    session.speechEnd(2000)

    expect(session.speechStart()).toBe('recording')
    expect(session.graceExpired(3200)).toBe('recording')
  })

  it('blocks detection during manual voice, assistant speech, and music playback', () => {
    const session = createAutoListenSession()

    session.enable()
    session.ready()

    expect(session.canDetect({ assistantSpeaking: false, manualVoiceActive: false, musicActive: false })).toBe(true)
    expect(session.canDetect({ assistantSpeaking: true, manualVoiceActive: false, musicActive: false })).toBe(false)
    expect(session.canDetect({ assistantSpeaking: false, manualVoiceActive: true, musicActive: false })).toBe(false)
    expect(session.canDetect({ assistantSpeaking: false, manualVoiceActive: false, musicActive: true })).toBe(false)
  })

  it('recovers from a failed capture without leaving the button locked', () => {
    const session = createAutoListenSession()

    session.enable()
    session.ready()
    session.speechStart()
    expect(session.fail()).toBe('error')
    expect(session.ready()).toBe('armed')
  })
})
