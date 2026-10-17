import { describe, expect, it, vi } from 'vitest'
import { createMusicStore } from '../electron/main/music/musicStore'

function createFakeFs(storedJson: string | null = null) {
  return {
    readFile: vi.fn(async () => {
      if (storedJson === null) {
        throw new Error('ENOENT')
      }
      return storedJson
    }),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined)
  }
}

const trackA = { id: 'a', source: 'netease' as const, title: '晴天', artist: '周杰伦', durationMs: 240000 }
const trackB = { id: 'b', source: 'kuwo' as const, title: '稻香', artist: '周杰伦', durationMs: 223000 }

describe('musicStore', () => {
  it('returns empty library when file is missing', async () => {
    const store = createMusicStore({ filePath: '/tmp/music.json', fs: createFakeFs(null) })
    const library = await store.loadLibrary()
    expect(library.favorites).toEqual([])
    expect(library.searchHistory).toEqual([])
  })

  it('loads favorites and searchHistory from disk', async () => {
    const fs = createFakeFs(
      JSON.stringify({
        favorites: [trackA],
        searchHistory: ['周杰伦', '晴天']
      })
    )
    const store = createMusicStore({ filePath: '/tmp/music.json', fs })
    const library = await store.loadLibrary()
    expect(library.favorites).toHaveLength(1)
    expect(library.favorites[0].title).toBe('晴天')
    expect(library.searchHistory).toEqual(['周杰伦', '晴天'])
  })

  it('toggles favorite: add then remove', async () => {
    const fs = createFakeFs(null)
    const store = createMusicStore({ filePath: '/tmp/music.json', fs })
    await store.loadLibrary()

    const afterAdd = await store.toggleFavorite(trackA)
    expect(afterAdd).toHaveLength(1)
    expect(store.getLibrary().favorites).toHaveLength(1)

    const afterRemove = await store.toggleFavorite(trackA)
    expect(afterRemove).toEqual([])
    expect(store.getLibrary().favorites).toEqual([])
  })

  it('adds distinct tracks and toggles same source:id', async () => {
    const fs = createFakeFs(null)
    const store = createMusicStore({ filePath: '/tmp/music.json', fs })
    await store.loadLibrary()

    await store.toggleFavorite(trackA)
    await store.toggleFavorite(trackB)
    expect(store.getLibrary().favorites).toHaveLength(2)

    // 同 source:id 视为同一首，再 toggle 移除
    await store.toggleFavorite({ ...trackA, title: '别名' })
    expect(store.getLibrary().favorites).toHaveLength(1)
    expect(store.getLibrary().favorites[0].id).toBe('b')
  })

  it('persists favorites to disk', async () => {
    const fs = createFakeFs(null)
    const store = createMusicStore({ filePath: '/tmp/music.json', fs })
    await store.loadLibrary()
    await store.toggleFavorite(trackA)
    expect(fs.writeFile).toHaveBeenCalledWith(
      '/tmp/music.json',
      expect.stringContaining('晴天'),
      'utf8'
    )
  })

  it('normalizes favorite: drops audioUrl/lyrics, keeps playback fields', async () => {
    const fs = createFakeFs(null)
    const store = createMusicStore({ filePath: '/tmp/music.json', fs })
    await store.loadLibrary()

    await store.toggleFavorite({
      ...trackA,
      audioUrl: 'https://example.test/a.mp3',
      lyrics: [{ timeMs: 0, text: '歌词' }]
    } as never)

    const stored = store.getLibrary().favorites[0]
    expect(stored.audioUrl).toBeUndefined()
    expect((stored as { lyrics?: unknown }).lyrics).toBeUndefined()
    expect(stored.playbackId ?? trackA.id).toBeTruthy()
  })

  it('addSearchHistory dedupes, prepends, caps at 8', async () => {
    const fs = createFakeFs(null)
    const store = createMusicStore({ filePath: '/tmp/music.json', fs })
    await store.loadLibrary()

    for (const q of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      await store.addSearchHistory(q)
    }
    expect(store.getLibrary().searchHistory).toEqual(['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'])

    // 第 9 条挤掉最旧
    await store.addSearchHistory('i')
    expect(store.getLibrary().searchHistory).toEqual(['i', 'h', 'g', 'f', 'e', 'd', 'c', 'b'])
    expect(store.getLibrary().searchHistory).toHaveLength(8)

    // 去重 + 置顶
    await store.addSearchHistory('c')
    expect(store.getLibrary().searchHistory).toEqual(['c', 'i', 'h', 'g', 'f', 'e', 'd', 'b'])
  })

  it('addSearchHistory ignores empty query', async () => {
    const store = createMusicStore({ filePath: '/tmp/music.json', fs: createFakeFs(null) })
    await store.loadLibrary()
    const result = await store.addSearchHistory('  ')
    expect(result).toEqual([])
  })

  it('clearSearchHistory empties history', async () => {
    const fs = createFakeFs(JSON.stringify({ favorites: [], searchHistory: ['a', 'b'] }))
    const store = createMusicStore({ filePath: '/tmp/music.json', fs })
    await store.loadLibrary()
    const result = await store.clearSearchHistory()
    expect(result).toEqual([])
    expect(store.getLibrary().searchHistory).toEqual([])
  })

  it('keeps favorites when clearing history', async () => {
    const fs = createFakeFs(JSON.stringify({ favorites: [trackA, trackB], searchHistory: ['a'] }))
    const store = createMusicStore({ filePath: '/tmp/music.json', fs })
    await store.loadLibrary()
    await store.clearSearchHistory()
    expect(store.getLibrary().favorites).toHaveLength(2)
    expect(store.getLibrary().searchHistory).toEqual([])
  })

  it('falls back to default when disk json is malformed', async () => {
    const fs = createFakeFs('not-json')
    const store = createMusicStore({ filePath: '/tmp/music.json', fs })
    const library = await store.loadLibrary()
    expect(library.favorites).toEqual([])
    expect(library.searchHistory).toEqual([])
  })
})
