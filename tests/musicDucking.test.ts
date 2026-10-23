import { afterEach, expect, it, vi } from 'vitest'
import { MusicDucking } from '../src/services/musicDucking'
afterEach(() => vi.useRealTimers())
it('ducks relative to current user volume and restores without resuming paused or muted music', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  const audio = { volume: 1, paused: true, muted: true, play: vi.fn() }
  const ducking = new MusicDucking(); ducking.attach(audio); ducking.setVolume(.8)
  ducking.setSpeechActive(true); vi.advanceTimersByTime(112)
  expect(audio.volume).toBeCloseTo(.16)
  ducking.setVolume(.4); expect(audio.volume).toBeCloseTo(.08)
  ducking.setSpeechActive(false); vi.advanceTimersByTime(304)
  expect(audio.volume).toBeCloseTo(.4)
  expect(audio.paused).toBe(true); expect(audio.muted).toBe(true); expect(audio.play).not.toHaveBeenCalled()
  ducking.dispose()
})
it('keeps zero volume and a replacement track under the active speech attenuation', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  const first = { volume: 1 }, next = { volume: 1 }
  const ducking = new MusicDucking(); ducking.attach(first)
  ducking.setSpeechActive(true); vi.advanceTimersByTime(112)
  ducking.attach(next); expect(next.volume).toBeCloseTo(.2)
  ducking.setVolume(0); ducking.setSpeechActive(false); vi.advanceTimersByTime(100)
  ducking.setSpeechActive(true); vi.advanceTimersByTime(112)
  expect(next.volume).toBe(0)
  ducking.dispose(); expect(vi.getTimerCount()).toBe(0)
})
