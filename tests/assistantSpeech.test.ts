import { afterEach, expect, it, vi } from 'vitest'
import { createAssistantSpeech } from '../src/services/assistantSpeech'
import { MusicDucking } from '../src/services/musicDucking'
afterEach(() => vi.useRealTimers())
function fixture() {
  let proactive = true
  const audios: Audio[] = [], request = vi.fn(async () => ({ ok: true as const, data: { audio: new ArrayBuffer(2), mimeType: 'audio/wav' } })), speaking = vi.fn(), ended = vi.fn(), release = vi.fn(), mark = vi.fn()
  class Audio {
    currentTime = 0
    play = vi.fn(async () => {})
    pause = vi.fn()
    listeners = new Map<string, () => void>()
    addEventListener(event: string, listener: () => void) { this.listeners.set(event, listener) }
    emit(event: string) { this.listeners.get(event)?.() }
  }
  const speaker = createAssistantSpeech({ request, canSpeakProactively: () => proactive, onSpeaking: speaking, onEnded: ended,
    configureOutput: async () => release, objectUrl: () => 'blob:synthetic', revokeUrl: vi.fn(), mark, createAudio: () => { const audio = new Audio(); audios.push(audio); return audio as unknown as HTMLAudioElement } })
  return { speaker, audios, request, speaking, ended, release, mark, quiet() { proactive = false; speaker.policyChanged() } }
}
it('records playback invocation separately from the actual media playing and ended events', async () => {
  const s = fixture()
  try {
    await s.speaker.speak('合成回答')
    expect(s.mark).toHaveBeenCalledWith('tts_play_invoked'); expect(s.mark).not.toHaveBeenCalledWith('tts_play_start')
    s.audios[0].emit('playing'); expect(s.mark).toHaveBeenLastCalledWith('tts_play_start')
    s.audios[0].emit('ended'); expect(s.mark).toHaveBeenLastCalledWith('tts_play_end')
  } finally { s.speaker.stop() }
})
it('plays a prepared bounded announcement through the same output owner without another TTS request', async () => {
  const s = fixture()
  await s.speaker.speak('任务结果', undefined, 'proactive', { ok: true, data: { audio: new ArrayBuffer(48), mimeType: 'audio/wav' } })
  expect(s.request).not.toHaveBeenCalled(); expect(s.audios).toHaveLength(1)
  s.audios[0].emit('playing'); expect(s.speaking).toHaveBeenLastCalledWith(true)
  s.quiet(); expect(s.audios[0].pause).toHaveBeenCalled(); expect(s.release).toHaveBeenCalledTimes(1)
})
it('reports actual device progress on interruption and ignores late ended events', async () => {
  const s = fixture(), report = vi.fn()
  await s.speaker.speak('任务简报', undefined, 'proactive', { ok: true, data: { audio: new ArrayBuffer(48), mimeType: 'audio/wav' } }, report)
  expect(report).not.toHaveBeenCalled()
  s.audios[0].emit('playing'); expect(report).toHaveBeenLastCalledWith({ status: 'started', playedUntilMs: 0 })
  s.audios[0].currentTime = .35; s.audios[0].emit('timeupdate')
  s.audios[0].currentTime = .42; s.speaker.stop()
  expect(report).toHaveBeenLastCalledWith({ status: 'interrupted', playedUntilMs: 420 })
  s.audios[0].currentTime = 1; s.audios[0].emit('ended')
  expect(report).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
})
it('marks completion only on the device ended event and does not follow it with interruption', async () => {
  const s = fixture(), report = vi.fn()
  await s.speaker.speak('任务简报', undefined, 'proactive', { ok: true, data: { audio: new ArrayBuffer(48), mimeType: 'audio/wav' } }, report)
  s.audios[0].emit('playing'); s.audios[0].currentTime = 1; s.audios[0].emit('ended')
  expect(report.mock.calls.map(call => call[0].status)).toEqual(['started', 'completed'])
  s.speaker.stop(); expect(report).toHaveBeenCalledTimes(2)
})
it('drops a late proactive TTS result after quiet mode without blocking a user-requested reply', async () => {
  const s = fixture(); let release!: (value: Awaited<ReturnType<typeof s.request>>) => void
  s.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const greeting = s.speaker.speak('合成问候', undefined, 'proactive')
  s.quiet(); release({ ok: true, data: { audio: new ArrayBuffer(2), mimeType: 'audio/wav' } }); await greeting
  expect(s.audios).toHaveLength(0)
  await s.speaker.speak('用户请求的回答'); expect(s.audios).toHaveLength(1)
  expect(s.speaking).not.toHaveBeenCalledWith(true)
  s.audios[0].emit('playing'); expect(s.speaking).toHaveBeenLastCalledWith(true)
  s.speaker.stop()
})
it('does not revive stopped audio when a delayed play promise completes', async () => {
  const s = fixture(); let release!: () => void
  const original = s.speaker.speak('合成回答')
  // Replace play before the output-binding await returns.
  await Promise.resolve()
  s.audios[0].play.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  s.speaker.stop(); release(); await original
  expect(s.audios[0].pause.mock.calls.length).toBeGreaterThanOrEqual(2)
  expect(s.release).toHaveBeenCalledTimes(1)
  expect(s.speaking).not.toHaveBeenCalledWith(true)
})
it('ducks only for actual playing events and restores the current base volume after speech ends', async () => {
  const s = fixture(), musicAudio = { volume: 1 }, duck = new MusicDucking()
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
  s.speaking.mockImplementation(active => duck.setSpeechActive(active))
  duck.attach(musicAudio); duck.setVolume(.6)
  try {
    await s.speaker.speak('合成回答'); vi.advanceTimersByTime(112); expect(musicAudio.volume).toBe(.6)
    s.audios[0].emit('playing'); vi.advanceTimersByTime(112); expect(musicAudio.volume).toBeCloseTo(.12)
    duck.setVolume(.3); s.audios[0].emit('ended'); vi.advanceTimersByTime(304)
    expect(musicAudio.volume).toBeCloseTo(.3); expect(s.ended).toHaveBeenCalledTimes(1)
  } finally { s.speaker.stop(); duck.dispose() }
})
