import { afterEach, expect, it, vi } from 'vitest'
import { monitorMicrophoneActivity } from '../src/services/microphoneActivity'
import { MusicDucking } from '../src/services/musicDucking'
afterEach(() => vi.useRealTimers())
it('measures microphone samples for ducking and stops activity before ASR waiting', () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  let sample = 128
  const disconnect = vi.fn(), close = vi.fn(async () => {}), analyser = { fftSize: 512, disconnect, getByteTimeDomainData(data: Uint8Array) { data.fill(sample) } }
  const context = { createMediaStreamSource: () => ({ connect: vi.fn(), disconnect }), createAnalyser: () => analyser, resume: async () => {}, close }
  const audio = { volume: 1 }, duck = new MusicDucking(); duck.attach(audio); duck.setVolume(.8)
  const stop = monitorMicrophoneActivity({} as MediaStream, active => duck.setSpeechActive(active), () => context as unknown as AudioContext)
  try {
    vi.advanceTimersByTime(200); expect(audio.volume).toBe(.8)
    sample = 160; vi.advanceTimersByTime(300); expect(audio.volume).toBeCloseTo(.16)
    duck.setVolume(.4); stop(); vi.advanceTimersByTime(304)
    expect(audio.volume).toBeCloseTo(.4); expect(close).toHaveBeenCalledTimes(1)
    stop(); expect(close).toHaveBeenCalledTimes(1)
  } finally { stop(); duck.dispose() }
})
