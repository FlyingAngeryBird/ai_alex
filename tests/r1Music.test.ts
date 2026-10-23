import { describe, expect, it, vi } from 'vitest'
import { openR1Database, inTransaction } from '../electron/main/r1/database'
import { R1Music, type MusicCommand } from '../electron/main/r1/music'
import { R1MusicTools } from '../electron/main/r1/musicTools'
import type { MusicProvider, MusicTrack } from '../electron/main/music/gdstudioMusicProvider'
const track = (source: MusicTrack['source'] = 'netease', title = '测试曲', artist = '测试歌手'): MusicTrack => ({ id: `${source}-1`, source, title, artist, durationMs: 180000 })
const scope = { temporary: false, persistenceConfirmed: false, assertCurrent() {} }
function fixture(auto = false) {
  const db = openR1Database(':memory:'), candidates = [track(), track('kuwo'), track('joox')], commands: MusicCommand[] = []
  const provider: MusicProvider = { authorize: async () => ({ authorized: true, provider: 'gdstudio' }), getPlaybackState: async () => ({ status: 'idle', track: null, positionMs: 0, durationMs: null }),
    pause: async () => ({ status: 'paused', track: null, positionMs: 0, durationMs: null }), resume: async () => ({ status: 'idle', track: null, positionMs: 0, durationMs: null }),
    search: vi.fn(async () => ({ tracks: candidates })), play: vi.fn(async payload => ({ status: 'playing' as const, positionMs: 0, durationMs: 180000,
      track: { ...candidates.find(item => item.source === payload.source)!, audioUrl: 'https://example.org/test.mp3' } })) }
  const music = new R1Music(db, provider, { timeoutMs: 100 }), nonce = music.attach(1, command => {
    commands.push(command)
    if (auto) queueMicrotask(() => { try { acknowledge(command) } catch (error) { if (!(error instanceof Error) || error.message !== 'MUSIC_STALE_DEVICE_REPORT') throw error } })
  })
  function acknowledge(command: MusicCommand, failed = false) {
    music.report(1, nonce, { commandId: command.commandId, playbackRequestId: command.playbackRequestId,
      status: failed ? 'failed' : ({ load: 'playing', resume: 'playing', pause: 'paused', seek: 'seeked', volume: 'volume', stop: 'stopped' } as const)[command.action],
      positionSec: command.positionSec, durationSec: 180 })
  }
  return { db, music, provider, candidates, commands, nonce, acknowledge, close() { music.close(); db.close() } }
}
describe('actual-device-gated R1 music domain', () => {
  it('retains a separately resolved cover when slower search results register the same song again', async () => {
    const s=fixture()
    try {
      await s.music.search('测试曲');s.provider.artwork=async()=> 'https://example.org/cover.jpg'
      expect(await s.music.artwork('netease:netease-1')).toBe('https://example.org/cover.jpg')
      await s.music.search('测试曲')
      expect(s.music.track('netease:netease-1').artworkUrl).toBe('https://example.org/cover.jpg')
      await expect(s.music.artwork('netease:unknown')).rejects.toThrow('MUSIC_TRACK_NOT_AVAILABLE')
    } finally {s.close()}
  })
  it('registers incremental candidates before the final search so early rows can be played', async () => {
    const s = fixture(true); let finish!: () => void
    try {
      s.provider.search = async (_payload, progress) => {
        progress?.({ tracks: [s.candidates[0]], sources: [{ source: 'netease', status: 'ready' }, { source: 'joox', status: 'searching' }] })
        await new Promise<void>(resolve => { finish = resolve })
        return { tracks: s.candidates }
      }
      const progress = vi.fn(), pending = s.music.search('测试曲', 'all', false, true, progress)
      expect(progress).toHaveBeenCalledTimes(1)
      expect(s.music.track('netease:netease-1').title).toBe('测试曲')
      expect(await s.music.media('music_play', { trackKey: 'netease:netease-1', expectedVersion: 1 }, scope)).toMatchObject({ state: { playState: 'playing' } })
      finish(); expect(await pending).toHaveLength(3)
    } finally { s.close() }
  })
  it('does not equate a resolved URL with playback, and rejects stale/wrong-window receipts', async () => {
    const s = fixture()
    try {
      const selected = (await s.music.search('测试曲'))[0], pending = s.music.media('music_play', { trackKey: `${selected.source}:${selected.id}`, expectedVersion: 1 }, scope)
      await vi.waitFor(() => expect(s.commands.some(command => command.action === 'load')).toBe(true))
      expect(s.music.state().playState).toBe('buffering')
      const command = s.commands.at(-1)!
      expect(() => s.music.report(2, s.nonce, { commandId: command.commandId, playbackRequestId: command.playbackRequestId, status: 'playing', positionSec: 0, durationSec: 180 })).toThrow('MUSIC_STALE_DEVICE_REPORT')
      s.acknowledge(command); expect(await pending).toMatchObject({ state: { playState: 'playing', playerVersion: 2 } })
      expect(s.music.attach(2, () => undefined)).not.toBe(s.nonce)
      expect(s.commands.at(-1)?.action).toBe('stop'); expect(s.music.state().playState).toBe('paused')
      expect(() => s.acknowledge(command)).toThrow('MUSIC_STALE_DEVICE_REPORT')
    } finally { s.close() }
  })
  it('keeps the new user volume while an earlier resource request is resolving', async () => {
    const s = fixture(); let release!: (result: Awaited<ReturnType<MusicProvider['play']>>) => void
    try {
      await s.music.search('测试曲')
      vi.mocked(s.provider.play).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      const playing = s.music.media('music_play', { trackKey: 'netease:netease-1', expectedVersion: 1 }, scope)
      const volume = s.music.media('music_set_volume', { expectedVersion: 2, volume: 40 }, scope)
      s.acknowledge(s.commands.at(-1)!); await volume
      release({ status: 'playing', track: { ...track(), audioUrl: 'https://example.org/test.mp3' }, positionMs: 0, durationMs: 180000 })
      await vi.waitFor(() => expect(s.commands.at(-1)?.action).toBe('load'))
      expect(s.commands.at(-1)).toMatchObject({ volume: 40, playerVersion: 3 })
      s.acknowledge(s.commands.at(-1)!); await playing
      expect(s.music.state()).toMatchObject({ baseVolume: 40, playState: 'playing' })
    } finally { s.close() }
  })
  it('lets a pause supersede unresolved playback without late autoplay', async () => {
    const s = fixture(); let release!: (result: Awaited<ReturnType<MusicProvider['play']>>) => void
    try {
      await s.music.search('测试曲'); vi.mocked(s.provider.play).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      const playing = s.music.media('music_play', { trackKey: 'netease:netease-1', expectedVersion: 1 }, scope), rejected = expect(playing).rejects.toThrow('MUSIC_SUPERSEDED')
      const pause = s.music.media('music_pause', { expectedVersion: 2 }, scope)
      s.acknowledge(s.commands.at(-1)!); await pause
      release({ status: 'playing', track: { ...track(), audioUrl: 'https://example.org/test.mp3' }, positionMs: 0, durationMs: 180000 })
      await rejected
      expect(s.commands.filter(command => command.action === 'load')).toHaveLength(0); expect(s.music.state().playState).toBe('paused')
    } finally { s.close() }
  })
  it('falls back only to the same title/artist/version and retains the actual source identity', async () => {
    const s = fixture(true)
    try {
      await s.music.search('测试曲')
      vi.mocked(s.provider.play).mockResolvedValueOnce({ status: 'error', track: null, positionMs: 0, durationMs: null })
      vi.mocked(s.provider.search).mockResolvedValueOnce({ tracks: [track('kuwo', '测试曲', '另一歌手'), track('joox', '测试曲 (Live)'), track('kuwo')] })
      const result = await s.music.media('music_play', { trackKey: 'netease:netease-1', expectedVersion: 1 }, scope)
      expect(result).toMatchObject({ state: { track: { trackKey: 'kuwo:kuwo-1', sourceProvider: 'kuwo' }, playState: 'playing' }, resourceAttempts: 2 })
      expect(vi.mocked(s.provider.play).mock.calls.map(([payload]) => payload.source)).toEqual(['netease', 'kuwo'])
    } finally { s.close() }
  })
  it('caps unavailable resources at three attempts and marks lost device acknowledgement unknown', async () => {
    const s = fixture()
    try {
      await s.music.search('测试曲'); vi.mocked(s.provider.play).mockResolvedValue({ status: 'error', track: null, positionMs: 0, durationMs: null })
      await expect(s.music.media('music_play', { trackKey: 'netease:netease-1', expectedVersion: 1 }, scope)).rejects.toThrow('MUSIC_RESOURCES_EXHAUSTED')
      expect(s.provider.play).toHaveBeenCalledTimes(3); expect(s.music.state().playState).toBe('failed')
      vi.mocked(s.provider.play).mockResolvedValue({ status: 'playing', track: { ...track(), audioUrl: 'https://example.org/test.mp3' }, positionMs: 0, durationMs: 180000 })
      await expect(s.music.media('music_play', { trackKey: 'netease:netease-1', expectedVersion: 2 }, scope)).rejects.toThrow('MUSIC_PLAYBACK_UNKNOWN')
      expect(s.commands.at(-1)?.action).toBe('stop')
    } finally { s.close() }
  })
  it('saves queue identities and feedback independently, and rolls back an outer failed transaction', async () => {
    const s = fixture(), changed = vi.fn()
    try {
      await s.music.search('测试曲'); s.music.onChanged(changed)
      const add = { action: 'add', queueVersion: 0, trackKeys: ['netease:netease-1', 'kuwo:kuwo-1'], entryIds: [], orderedEntryIds: [] }
      expect(() => inTransaction(s.db, () => { s.music.local('music_queue', add, scope); throw new Error('rollback') })).toThrow('rollback')
      expect(s.music.state()).toMatchObject({ queueVersion: 0, queue: [] }); expect(changed).not.toHaveBeenCalled()
      s.music.local('music_queue', add, scope)
      const entries = s.music.state().queue
      s.music.local('music_queue', { action: 'reorder', queueVersion: 1, trackKeys: [], entryIds: [], orderedEntryIds: entries.map(entry => entry.entryId).reverse() }, scope)
      expect(() => s.music.local('music_queue', { ...add, queueVersion: 0 }, scope)).toThrow('VERSION_CONFLICT')
      s.music.local('music_favorite', { trackKey: 'netease:netease-1', favorite: true }, scope)
      s.music.local('music_feedback', { trackKey: 'netease:netease-1', feedback: 'skip', scene: null }, scope)
      expect(s.music.snapshot().favorites).toHaveLength(1)
      expect(s.db.prepare('SELECT kind FROM music_feedback').all()).toEqual([{ kind: 'skip' }])
      const reopened = new R1Music(s.db, s.provider)
      expect(reopened.state()).toMatchObject({ playState: 'idle', queueVersion: 2, queue: [{ entryId: entries[1].entryId }, { entryId: entries[0].entryId }] })
      expect(reopened.snapshot().favorites).toHaveLength(1); reopened.close()
    } finally { s.close() }
  })
  it('requires observed track keys and versions and rejects temporary persistent writes', async () => {
    const s = fixture(true), tools = new R1MusicTools(s.music, scope)
    try {
      await expect(tools.execute('music_play', { trackKey: 'netease:netease-1', expectedVersion: 1 })).rejects.toThrow('MUSIC_STATE_NOT_OBSERVED')
      await tools.execute('music_search', { keyword: '测试曲' }); tools.local('music_get_state', {})
      expect(() => tools.local('music_favorite', { trackKey: 'invented', favorite: true })).toThrow('MUSIC_TRACK_NOT_OBSERVED')
      await tools.execute('music_play', { trackKey: 'netease:netease-1', expectedVersion: 1 })
      const temporary = new R1MusicTools(s.music, { ...scope, temporary: true })
      temporary.local('music_get_state', {})
      expect(() => temporary.local('music_favorite', { trackKey: 'netease:netease-1', favorite: true })).toThrow('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM music_favorites').get()).toMatchObject({ n: 0 })
    } finally { s.close() }
  })
  it('applies explicit dislike without turning a skip into a ban, and isolates temporary search from feedback', async () => {
    const s = fixture()
    try {
      await s.music.search('放松')
      s.music.local('music_feedback', { trackKey: 'netease:netease-1', feedback: 'dislike', scene: '放松' }, scope)
      s.music.local('music_feedback', { trackKey: 'netease:netease-1', feedback: 'skip', scene: null }, scope)
      expect((await s.music.search('放松')).map(t => t.source)).toEqual(['kuwo', 'joox', 'netease'])
      expect((await s.music.search('测试曲')).map(t => t.source)).toEqual(['netease', 'kuwo', 'joox'])
      const temporary = new R1MusicTools(s.music, { ...scope, temporary: true })
      expect((await temporary.execute('music_search', { keyword: '放松' })).tracks).toEqual(expect.arrayContaining([expect.objectContaining({ trackKey: 'netease:netease-1' })]))
      expect(((await temporary.execute('music_search', { keyword: '放松' })).tracks as Array<{ trackKey: string }>)[0].trackKey).toBe('netease:netease-1')
      expect(temporary.local('music_get_state', {}).feedback).toEqual([])
      expect(s.music.local('music_get_state', {}, scope).feedback).toHaveLength(2)
    } finally { s.close() }
  })
})
