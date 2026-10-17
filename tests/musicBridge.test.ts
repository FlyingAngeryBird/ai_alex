import { afterEach, expect, it, vi } from 'vitest'
import { useMusic } from '../src/composables/useMusic'
import { openR1Database } from '../electron/main/r1/database'
import { R1Music, type MusicCommand, type MusicSnapshot } from '../electron/main/r1/music'
import type { R1Api } from '../electron/shared/r1Api'
import type { MusicProvider, MusicTrack } from '../electron/main/music/gdstudioMusicProvider'
import { getCurrentLyricIndex } from '../src/utils/musicLyrics'
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
function fixture(options: Parameters<typeof useMusic>[0] = {}) {
  const db = openR1Database(':memory:'), first: MusicTrack = { source: 'netease', id: 'one', title: '第一首', artist: '测试歌手', durationMs: 180000,
    lyrics: [{ timeMs: 0, text: '第一句' }, { timeMs: 2000, text: '第二句' }] }, second = { ...first, id: 'two', title: '第二首' }
  const provider: MusicProvider = { authorize: async () => ({ authorized: true, provider: 'gdstudio' }), getPlaybackState: async () => ({ status: 'idle', track: null, positionMs: 0, durationMs: null }),
    pause: async () => ({ status: 'paused', track: null, positionMs: 0, durationMs: null }), resume: async () => ({ status: 'idle', track: null, positionMs: 0, durationMs: null }),
    search: async () => ({ tracks: [first, second] }), play: async payload => ({ status: 'playing', track: { ...(payload.trackId === 'two' ? second : first), audioUrl: 'https://example.org/fixture.mp3' }, durationMs: 180000, positionMs: 0 }) }
  const domain = new R1Music(db, provider, { timeoutMs: 500 })
  const commandListeners = new Set<(command: MusicCommand) => void>(), stateListeners = new Set<(snapshot: MusicSnapshot) => void>()
  domain.onChanged(snapshot => { for (const listener of stateListeners) listener(snapshot) })
  const api: R1Api['music'] = {
    attach: async () => ({ ok: true, data: { nonce: domain.attach(1, command => { for (const listener of commandListeners) listener(command) }), snapshot: domain.snapshot() } }),
    detach: async () => { domain.detach(1); return { ok: true, data: null } }, snapshot: async () => ({ ok: true, data: domain.snapshot() }),
    report: async input => { try { domain.report(1, input.nonce, input.report); return { ok: true, data: null } } catch { return { ok: false, error: { code: 'MUSIC_STALE_DEVICE_REPORT', message: '' } } } },
    search: async () => ({ ok: true, data: await domain.search('测试') }), clearHistory: async () => ({ ok: true, data: null }),
    exit: async input => ({ ok: true, data: await domain.exit(input.expectedVersion) }),
    control: async input => {
      try { const scope = { temporary: false, persistenceConfirmed: false, assertCurrent() {} }
        const data = ['music_queue', 'music_favorite', 'music_feedback', 'music_get_state'].includes(input.alias) ? domain.local(input.alias, input.args, scope) : await domain.media(input.alias, input.args, scope)
        return { ok: true, data }
      } catch (error) { return { ok: false, error: { code: (error as Error).message, message: '' } } }
    },
    onCommand: listener => { commandListeners.add(listener); return () => commandListeners.delete(listener) },
    onChanged: listener => { stateListeners.add(listener); return () => stateListeners.delete(listener) }
  }
  vi.stubGlobal('window', { seamoR1: { music: api } })
  const audios: Audio[] = []
  class Audio {
    volume = 1; duration = 180; currentTime = 0; src = ''; crossOrigin = ''; preload = ''; paused = true
    listeners = new Map<string, Set<() => void>>()
    play = vi.fn(async () => { this.paused = false })
    pause = vi.fn(() => { this.paused = true })
    removeAttribute() { this.src = '' }
    addEventListener(name: string, listener: () => void) { const set = this.listeners.get(name) ?? new Set(); set.add(listener); this.listeners.set(name, set) }
    removeEventListener(name: string, listener: () => void) { this.listeners.get(name)?.delete(listener) }
    fire(name: string) { for (const listener of this.listeners.get(name) ?? []) listener() }
  }
  const music = useMusic({ createAudioContext: () => null, ...options, createAudioElement: () => { const audio = new Audio(); audios.push(audio); return audio as unknown as HTMLAudioElement } })
  return { db, domain, music, api, first, second, audios, close() { music.dispose(); domain.close(); db.close() } }
}
it('uses the production audio bridge for play, seek, favorites and persistent queue without implicit search queuing', async () => {
  const s = fixture()
  try {
    await s.music.loadLibrary(); await s.music.searchMusic('测试'); await s.music.playSearchResult(s.first)
    expect(s.domain.state()).toMatchObject({ playState: 'playing', track: { trackKey: 'netease:one' } })
    expect(s.music.queueEntries.value).toEqual([])
    await s.music.seek(45); expect(s.audios[0].currentTime).toBe(45); expect(s.domain.state().positionSec).toBe(45)
    await s.music.toggleFavorite(s.first); expect(s.music.favorites.value).toHaveLength(1)
    await s.music.addToQueue(s.second); expect(s.music.queueVersion.value).toBe(1)
    await s.music.nextTrack(); expect(s.domain.state()).toMatchObject({ playState: 'playing', track: { trackKey: 'netease:two' }, queue: [] })
    await s.music.nextTrack(); expect(s.domain.state().playState).toBe('ended')
    expect(s.audios.at(-1)?.paused).toBe(true)
  } finally { s.close() }
})
it('keeps search, play, seek, lyric clock, ducking and next-track on one real local player path', async () => {
  const s = fixture()
  try {
    await s.music.searchMusic('测试')
    expect(s.music.searchResults.value).toHaveLength(2)
    await s.music.playSearchResult(s.first)
    expect(s.domain.state()).toMatchObject({ playState: 'playing', track: { trackKey: 'netease:one' } })
    expect(s.music.playback.value.track?.lyrics).toHaveLength(2)
    expect(getCurrentLyricIndex(s.music.playback.value.track?.lyrics, 2100)).toBe(1)
    await s.music.seek(45)
    expect(s.audios[0].currentTime).toBe(45)
    const base = s.audios[0].volume
    s.music.setSpeechActive(true)
    await new Promise(resolve => setTimeout(resolve, 160))
    expect(s.audios[0].volume).toBeCloseTo(base * 0.2, 2)
    s.music.setSpeechActive(false)
    await new Promise(resolve => setTimeout(resolve, 380))
    expect(s.audios[0].volume).toBeCloseTo(base, 2)
    await s.music.addToQueue(s.second)
    await s.music.nextTrack()
    expect(s.domain.state()).toMatchObject({ playState: 'playing', track: { trackKey: 'netease:two' } })
    expect(s.audios.at(-1)).not.toBe(s.audios[0])
  } finally { s.close() }
})
it('never lets an earlier play promise revive audio after a pause', async () => {
  const s = fixture(); let release!: () => void
  try {
    await s.music.loadLibrary(); await s.music.searchMusic('测试')
    // Hold the device's play acknowledgement, then issue an actual pause through the domain.
    const originalCreate = s.music.playSearchResult(s.first)
    await vi.waitFor(() => expect(s.audios).toHaveLength(1))
    await originalCreate
    s.audios[0].play.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    await s.music.togglePlayback()
    const resume = s.music.togglePlayback()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await s.domain.media('music_pause', { expectedVersion: s.domain.state().playerVersion }, { temporary: false, persistenceConfirmed: false, assertCurrent() {} })
    release(); await resume
    expect(s.domain.state().playState).toBe('paused')
    expect(s.music.playback.value.status).toBe('paused')
  } finally { s.close() }
})
it('exits the authoritative player without erasing the separately saved queue or reviving its track', async () => {
  const s = fixture()
  try {
    await s.music.loadLibrary(); await s.music.searchMusic('测试'); await s.music.playSearchResult(s.first); await s.music.addToQueue(s.second)
    await s.music.exitPlayback()
    expect(s.domain.state()).toMatchObject({ track: null, playState: 'idle', queue: [{ track: { trackKey: 'netease:two' } }] })
    await s.music.loadLibrary()
    expect(s.music.playback.value.track).toBeNull(); expect(s.audios[0].paused).toBe(true)
    expect(s.music.queueEntries.value).toHaveLength(1)
  } finally { s.close() }
})
it('keeps a one-time skip separate from dislike', async () => {
  const s = fixture()
  try {
    await s.music.loadLibrary(); await s.music.searchMusic('测试'); await s.music.playSearchResult(s.first); await s.music.addToQueue(s.second)
    await s.music.feedbackAndSkip(s.first, 'skip')
    expect(s.db.prepare('SELECT kind FROM music_feedback').all()).toEqual([{ kind: 'skip' }])
    expect(s.domain.state().track?.trackKey).toBe('netease:two')
  } finally { s.close() }
})
it('does not pause a user-selected replacement track when an old focus target completes', async () => {
  const s = fixture()
  try {
    await s.music.loadLibrary(); await s.music.searchMusic('测试'); await s.music.playSearchResult(s.first)
    await s.music.playSearchResult(s.second)
    await s.music.pauseTrack('netease:one')
    expect(s.domain.state()).toMatchObject({ playState: 'playing', track: { trackKey: 'netease:two' } })
    await s.music.pauseTrack('netease:two'); expect(s.domain.state().playState).toBe('paused')
  } finally { s.close() }
})
it('drops an older search response after a new query has completed', async () => {
  const s = fixture(); let release!: (value: Awaited<ReturnType<R1Api['music']['search']>>) => void
  try {
    await s.music.loadLibrary()
    vi.spyOn(s.api, 'search').mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      .mockResolvedValueOnce({ ok: true, data: [s.second] })
    const previous = s.music.searchMusic('较早查询')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await s.music.searchMusic('较新查询'); release({ ok: true, data: [s.first] }); await previous
    expect(s.music.searchResults.value).toEqual([s.second])
  } finally { s.close() }
})
it('does not start a misleading play-all operation after its queue update failed', async () => {
  const s = fixture()
  try {
    await s.music.loadLibrary(); await s.music.searchMusic('测试'); await s.music.toggleFavorite(s.first); await s.music.toggleFavorite(s.second)
    vi.spyOn(s.api, 'control').mockResolvedValueOnce({ ok: false, error: { code: 'VERSION_CONFLICT', message: '' } })
    await s.music.playAllFavorites()
    expect(s.audios).toHaveLength(0); expect(s.domain.state().playState).toBe('idle')
    expect(s.music.musicNotice.value).toContain('播放器状态已变化')
  } finally { s.close() }
})
it('recreates audio after an output-device failure and only resumes after a fresh device acknowledgement', async () => {
  const s = fixture()
  try {
    await s.music.loadLibrary(); await s.music.searchMusic('测试'); await s.music.playSearchResult(s.first)
    s.music.outputFailed()
    expect(s.audios[0].paused).toBe(true); expect(s.domain.state().playState).toBe('failed')
    await s.music.togglePlayback()
    expect(s.audios).toHaveLength(2); expect(s.domain.state().playState).toBe('playing')
    expect(s.audios[0].paused).toBe(true)
  } finally { s.close() }
})
it('shares a pending Web Audio route across pause/resume without binding the same element twice', async () => {
  const context = { createAnalyser: () => ({ fftSize: 256, frequencyBinCount: 128, smoothingTimeConstant: 0, connect() {}, disconnect() {}, getByteFrequencyData(data: Uint8Array) { data.fill(0) } }),
    createMediaElementSource: vi.fn(() => ({ connect() {}, disconnect() {} })), resume: async () => {}, close: async () => {}, destination: {} }
  let release!: () => void
  const s = fixture({ createAudioContext: () => context as unknown as AudioContext, configureOutput: async target => {
    if (target === context as unknown as AudioContext) await new Promise<void>(resolve => { release = resolve })
    return () => {}
  } })
  try {
    await s.music.loadLibrary(); await s.music.searchMusic('测试')
    const first = s.music.playSearchResult(s.first)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await s.domain.media('music_pause', { expectedVersion: s.domain.state().playerVersion }, { temporary: false, persistenceConfirmed: false, assertCurrent() {} })
    const resumed = s.music.togglePlayback(); release(); await resumed; await first
    expect(context.createMediaElementSource).toHaveBeenCalledTimes(1)
    expect(s.domain.state().playState).toBe('playing')
  } finally { s.close() }
})
