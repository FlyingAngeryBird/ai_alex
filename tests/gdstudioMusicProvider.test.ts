import { describe, expect, it, vi } from 'vitest'
import { createGdStudioMusicProvider } from '../electron/main/music/gdstudioMusicProvider'

type FakeTrack = {
  id: string
  name: string
  artist?: string[]
  album?: string
  pic_id?: string
  lyric_id?: string
  url_id?: string
  source?: string
}

type FakeGdData = {
  lyrics?: Record<string, string>
  pics?: Record<string, string>
  search?: Record<string, FakeTrack[]>
  urls?: Record<string, string>
}

function createFakeGdFetch(data: FakeGdData) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input.toString())
    const type = url.searchParams.get('types')
    const source = url.searchParams.get('source') ?? ''
    const id = url.searchParams.get('id') ?? ''

    if (type === 'search') {
      return Response.json(data.search?.[source] ?? [])
    }

    if (type === 'url') {
      return Response.json({
        url: data.urls?.[`${source}:${id}`] ?? ''
      })
    }

    if (type === 'pic') {
      return Response.json({
        url: data.pics?.[`${source}:${id}`] ?? ''
      })
    }

    if (type === 'lyric') {
      return Response.json({
        lyric: data.lyrics?.[`${source}:${id}`] ?? ''
      })
    }

    return Response.json({})
  })
}

function requestedSources(fetcher: ReturnType<typeof createFakeGdFetch>, type: string): string[] {
  return fetcher.mock.calls
    .map(([input]) => new URL(input.toString()))
    .filter((url) => url.searchParams.get('types') === type)
    .map((url) => url.searchParams.get('source') ?? '')
}

function requestedIds(fetcher: ReturnType<typeof createFakeGdFetch>, type: string): string[] {
  return fetcher.mock.calls
    .map(([input]) => new URL(input.toString()))
    .filter((url) => url.searchParams.get('types') === type)
    .map((url) => url.searchParams.get('id') ?? '')
}

describe('GD Studio music provider', () => {
  it('starts supported-source searches concurrently and bounds cover requests when a source ignores count', async () => {
    let release!: () => void
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString()), type = url.searchParams.get('types'), source = url.searchParams.get('source')
      if (type === 'search' && source === 'netease') { await new Promise<void>(resolve => { release = resolve }); return Response.json([]) }
      if (type === 'search' && source === 'kuwo') return new Response('', { status: 400 })
      if (type === 'search') return Response.json(Array.from({ length: 30 }, (_, index) => ({ id: `joox-${index}`, name: `合成曲${index}`, artist: ['合成歌手'], pic_id: `cover-${index}` })))
      return Response.json({ url: 'https://example.org/cover.jpg' })
    })
    const provider = createGdStudioMusicProvider({ fetch: fetcher })
    try {
      const pending = provider.search({ query: '合成查询', sourcePreference: 'all' })
      await vi.waitFor(() => expect(requestedSources(fetcher, 'search')).toEqual(['netease', 'kuwo', 'joox']))
      release(); expect((await pending).tracks).toHaveLength(5)
      expect(requestedSources(fetcher, 'pic')).toHaveLength(5)
    } finally { provider.close?.() }
  })
  it('continues to the next source when one GD Studio source returns 503', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      const type = url.searchParams.get('types')
      const source = url.searchParams.get('source')

      if (type === 'search' && source === 'netease') {
        return new Response('service unavailable', { status: 503 })
      }

      if (type === 'search' && source === 'kuwo') {
        return Response.json([
          {
            artist: ['云边有间音乐馆'],
            id: 'kuwo-relax-1',
            name: '记住此刻的心情',
            source: 'kuwo',
            url_id: 'kuwo-relax-url-1'
          }
        ])
      }

      if (type === 'url' && source === 'kuwo') {
        return Response.json({
          url: 'https://example.test/relax.mp3'
        })
      }

      return Response.json({})
    })
    const provider = createGdStudioMusicProvider({ fetch: fetcher })

    await expect(provider.play({ query: '适合此刻的音乐', sourcePreference: 'all' })).resolves.toMatchObject({
      status: 'playing',
      track: {
        audioUrl: 'https://example.test/relax.mp3',
        source: 'kuwo',
        title: '记住此刻的心情'
      }
    })
  })

  it('continues to the next candidate when one playable url request returns 503', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      const type = url.searchParams.get('types')
      const id = url.searchParams.get('id')

      if (type === 'search') {
        return Response.json([
          {
            artist: ['云边有间音乐馆'],
            id: 'broken-track',
            name: '暂时失联的歌',
            source: 'kuwo',
            url_id: 'broken-url'
          },
          {
            artist: ['门店音乐馆'],
            id: 'good-track',
            name: '此刻的安宁',
            source: 'kuwo',
            url_id: 'good-url'
          }
        ])
      }

      if (type === 'url' && id === 'broken-url') {
        return new Response('service unavailable', { status: 503 })
      }

      if (type === 'url' && id === 'good-url') {
        return Response.json({
          url: 'https://example.test/calm.mp3'
        })
      }

      return Response.json({})
    })
    const provider = createGdStudioMusicProvider({ fetch: fetcher })

    await expect(provider.play({ query: '适合此刻的音乐', sourcePreference: 'kuwo' })).resolves.toMatchObject({
      status: 'playing',
      track: {
        audioUrl: 'https://example.test/calm.mp3',
        id: 'good-track',
        title: '此刻的安宁'
      }
    })
  })

  it('keeps playing when optional lyric or artwork requests return 503', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      const type = url.searchParams.get('types')

      if (type === 'search') {
        return Response.json([
          {
            artist: ['云边有间音乐馆'],
            id: 'kuwo-relax-1',
            lyric_id: 'kuwo-lyric-1',
            name: '记住此刻的心情',
            pic_id: 'kuwo-pic-1',
            source: 'kuwo',
            url_id: 'kuwo-url-1'
          }
        ])
      }

      if (type === 'url') {
        return Response.json({
          url: 'https://example.test/relax.mp3'
        })
      }

      if (type === 'pic' || type === 'lyric') {
        return new Response('service unavailable', { status: 503 })
      }

      return Response.json({})
    })
    const provider = createGdStudioMusicProvider({ fetch: fetcher })

    await expect(provider.play({ query: '适合此刻的音乐', sourcePreference: 'kuwo' })).resolves.toMatchObject({
      status: 'playing',
      track: {
        audioUrl: 'https://example.test/relax.mp3',
        title: '记住此刻的心情'
      }
    })
  })

  it('resolves the first playable track by default source order', async () => {
    const fetcher = createFakeGdFetch({
      search: {
        netease: [],
        kuwo: [
          {
            album: '魔杰座',
            artist: ['周杰伦'],
            id: 'kuwo-1',
            lyric_id: 'kuwo-lyric-1',
            name: '稻香',
            pic_id: 'kuwo-pic-1',
            source: 'kuwo',
            url_id: 'kuwo-url-1'
          }
        ],
        joox: [
          {
            album: '魔杰座',
            artist: ['周杰倫'],
            id: 'joox-1',
            lyric_id: 'joox-lyric-1',
            name: '稻香',
            pic_id: 'joox-pic-1',
            source: 'joox',
            url_id: 'joox-url-1'
          }
        ]
      },
      urls: {
        'kuwo:kuwo-url-1': '',
        'joox:joox-url-1': 'https://example.test/daoxiang.mp3'
      },
      lyrics: {
        'joox:joox-lyric-1': '[00:01.00]第一句\n[00:02.50]第二句'
      },
      pics: {
        'joox:joox-pic-1': 'https://example.test/cover.jpg'
      }
    })
    const provider = createGdStudioMusicProvider({ fetch: fetcher })

    await expect(provider.play({ query: '稻香', sourcePreference: 'all' })).resolves.toMatchObject({
      durationMs: 0,
      positionMs: 0,
      status: 'playing',
      track: {
        album: '魔杰座',
        artist: '周杰倫',
        artworkUrl: 'https://example.test/cover.jpg',
        audioUrl: 'https://example.test/daoxiang.mp3',
        id: 'joox-1',
        lyrics: [
          { timeMs: 1000, text: '第一句' },
          { timeMs: 2500, text: '第二句' }
        ],
        source: 'joox',
        title: '稻香'
      }
    })
    expect(requestedSources(fetcher, 'search')).toEqual(['netease', 'kuwo', 'joox'])
    expect(requestedSources(fetcher, 'url')).toEqual(['kuwo', 'joox'])
  })

  it('only tries the selected source in single-source mode', async () => {
    const fetcher = createFakeGdFetch({
      search: {
        kuwo: [
          {
            artist: ['周杰伦'],
            id: 'kuwo-1',
            name: '稻香',
            source: 'kuwo'
          }
        ],
        joox: [
          {
            artist: ['周杰倫'],
            id: 'joox-1',
            name: '稻香',
            source: 'joox'
          }
        ]
      },
      urls: {
        'kuwo:kuwo-1': '',
        'joox:joox-1': 'https://example.test/daoxiang.mp3'
      }
    })
    const provider = createGdStudioMusicProvider({ fetch: fetcher })

    await expect(provider.play({ query: '稻香', sourcePreference: 'kuwo' })).resolves.toMatchObject({
      errorMessage: '没有找到可播放的音乐，请换个关键词或音源再试试。',
      status: 'error',
      track: null
    })
    expect(requestedSources(fetcher, 'search')).toEqual(['kuwo'])
    expect(requestedSources(fetcher, 'url')).toEqual(['kuwo'])
  })

  it('keeps single-source mode anchored to the requested source when search metadata disagrees', async () => {
    const fetcher = createFakeGdFetch({
      search: {
        kuwo: [
          {
            artist: ['周杰伦'],
            id: 'kuwo-1',
            name: '稻香',
            source: 'joox'
          }
        ]
      },
      urls: {
        'kuwo:kuwo-1': 'https://example.test/kuwo-daoxiang.mp3',
        'joox:kuwo-1': ''
      }
    })
    const provider = createGdStudioMusicProvider({ fetch: fetcher })

    await expect(provider.play({ query: '稻香', sourcePreference: 'kuwo' })).resolves.toMatchObject({
      status: 'playing',
      track: {
        audioUrl: 'https://example.test/kuwo-daoxiang.mp3',
        source: 'kuwo'
      }
    })
    expect(requestedSources(fetcher, 'url')).toEqual(['kuwo'])
  })

  it('returns a clear error when every resolved URL is empty', async () => {
    const fetcher = createFakeGdFetch({
      search: {
        netease: [
          {
            artist: ['周杰伦'],
            id: 'netease-1',
            name: '稻香',
            source: 'netease'
          }
        ],
        kuwo: [
          {
            artist: ['周杰伦'],
            id: 'kuwo-1',
            name: '稻香',
            source: 'kuwo'
          }
        ],
        joox: [
          {
            artist: ['周杰倫'],
            id: 'joox-1',
            name: '稻香',
            source: 'joox'
          }
        ]
      },
      urls: {
        'netease:netease-1': '',
        'kuwo:kuwo-1': '',
        'joox:joox-1': ''
      }
    })
    const provider = createGdStudioMusicProvider({ fetch: fetcher })

    await expect(provider.play({ query: '稻香', sourcePreference: 'all' })).resolves.toEqual({
      durationMs: null,
      errorMessage: '没有找到可播放的音乐，请换个关键词或音源再试试。',
      positionMs: 0,
      status: 'error',
      track: null
    })
  })

  it('reuses cached search results for the same keyword and source within TTL', async () => {
    let now = 1_000
    const fetcher = createFakeGdFetch({
      search: {
        kuwo: [
          {
            album: '魔杰座',
            artist: ['周杰伦'],
            id: 'kuwo-1',
            name: '稻香',
            source: 'kuwo'
          }
        ]
      }
    })
    const provider = createGdStudioMusicProvider({
      fetch: fetcher,
      now: () => now
    })

    await expect(provider.search({ query: '稻香', sourcePreference: 'kuwo' })).resolves.toEqual({
      tracks: [
        {
          album: '魔杰座',
          artist: '周杰伦',
          durationMs: 0,
          id: 'kuwo-1',
          recommendation: '来自 GD Studio kuwo 的搜索结果。',
          source: 'kuwo',
          title: '稻香'
        }
      ]
    })
    now += 60_000
    await provider.search({ query: '稻香', sourcePreference: 'kuwo' })

    expect(requestedSources(fetcher, 'search')).toEqual(['kuwo'])
  })

  it('hydrates search results with artwork urls so manual selection keeps cover art', async () => {
    const fetcher = createFakeGdFetch({
      pics: {
        'joox:2726092be436956b': 'https://image.joox.com/JOOXcover/0/2726092be436956b/500'
      },
      search: {
        joox: [
          {
            album: '太陽之子',
            artist: ['周杰倫'],
            id: 'c9SvcsEGhTBjgH9AlCniBA==',
            lyric_id: 'c9SvcsEGhTBjgH9AlCniBA==',
            name: '愛琴海',
            pic_id: '2726092be436956b',
            source: 'joox',
            url_id: 'c9SvcsEGhTBjgH9AlCniBA=='
          }
        ]
      }
    })
    const provider = createGdStudioMusicProvider({ fetch: fetcher })

    await expect(provider.search({ query: '愛琴海', sourcePreference: 'joox' })).resolves.toEqual({
      tracks: [
        expect.objectContaining({
          artworkId: '2726092be436956b',
          artworkUrl: 'https://image.joox.com/JOOXcover/0/2726092be436956b/500',
          title: '愛琴海'
        })
      ]
    })
    expect(requestedIds(fetcher, 'pic')).toEqual(['2726092be436956b'])
  })

  it('plays an exact selected search result with GD playback, lyric, artwork ids and keeps metadata', async () => {
    const fetcher = createFakeGdFetch({
      search: {
        joox: [
          {
            album: '十一月的萧邦',
            artist: ['周杰伦'],
            id: 'joox-search-77',
            lyric_id: 'joox-lyric-77',
            name: '爱情海',
            pic_id: 'joox-pic-77',
            source: 'joox',
            url_id: 'joox-url-77'
          }
        ]
      },
      urls: {
        'joox:joox-url-77': 'https://example.test/aiqinghai.mp3'
      },
      lyrics: {
        'joox:joox-lyric-77': '[00:01.00]瓶裹的沙'
      },
      pics: {
        'joox:joox-pic-77': 'https://example.test/aiqinghai.jpg'
      }
    })
    const provider = createGdStudioMusicProvider({ fetch: fetcher })
    const searchResult = await provider.search({ query: '爱情海', sourcePreference: 'joox' })
    const selected = searchResult.tracks[0]

    expect(selected).toMatchObject({
      album: '十一月的萧邦',
      artist: '周杰伦',
      artworkId: 'joox-pic-77',
      id: 'joox-search-77',
      lyricId: 'joox-lyric-77',
      playbackId: 'joox-url-77',
      source: 'joox',
      title: '爱情海'
    })

    await expect(
      provider.play({
        album: selected.album,
        artist: selected.artist,
        artworkId: selected.artworkId,
        artworkUrl: selected.artworkUrl,
        durationMs: selected.durationMs,
        lyricId: selected.lyricId,
        playbackId: selected.playbackId,
        source: selected.source,
        title: selected.title,
        trackId: selected.id
      })
    ).resolves.toMatchObject({
      status: 'playing',
      track: {
        album: '十一月的萧邦',
        artist: '周杰伦',
        artworkUrl: 'https://example.test/aiqinghai.jpg',
        audioUrl: 'https://example.test/aiqinghai.mp3',
        id: 'joox-search-77',
        lyrics: [{ text: '瓶裹的沙', timeMs: 1000 }],
        source: 'joox',
        title: '爱情海'
      }
    })
    expect(requestedIds(fetcher, 'url')).toEqual(['joox-url-77'])
    expect(requestedIds(fetcher, 'lyric')).toEqual(['joox-lyric-77'])
    expect(requestedIds(fetcher, 'pic')).toEqual(['joox-pic-77'])
  })

  it('recovers selected joox metadata from search cache when playback payload only carries ids', async () => {
    const fetcher = createFakeGdFetch({
      search: {
        joox: [
          {
            album: '太陽之子',
            artist: ['周杰倫'],
            id: 'c9SvcsEGhTBjgH9AlCniBA==',
            lyric_id: 'c9SvcsEGhTBjgH9AlCniBA==',
            name: '愛琴海',
            pic_id: '2726092be436956b',
            source: 'joox',
            url_id: 'c9SvcsEGhTBjgH9AlCniBA=='
          }
        ]
      },
      urls: {
        'joox:c9SvcsEGhTBjgH9AlCniBA==': 'https://example.test/aiqinghai.mp3'
      },
      lyrics: {
        'joox:c9SvcsEGhTBjgH9AlCniBA==': '[00:01.00]愛琴海 - 周杰倫'
      },
      pics: {
        'joox:2726092be436956b': 'https://image.joox.com/JOOXcover/0/2726092be436956b/500'
      }
    })
    const provider = createGdStudioMusicProvider({ fetch: fetcher })
    const searchResult = await provider.search({ query: '愛琴海', sourcePreference: 'joox' })
    const selected = searchResult.tracks[0]

    await expect(
      provider.play({
        playbackId: selected.playbackId,
        source: selected.source,
        trackId: selected.id
      })
    ).resolves.toMatchObject({
      status: 'playing',
      track: {
        album: '太陽之子',
        artist: '周杰倫',
        artworkId: '2726092be436956b',
        artworkUrl: 'https://image.joox.com/JOOXcover/0/2726092be436956b/500',
        audioUrl: 'https://example.test/aiqinghai.mp3',
        id: 'c9SvcsEGhTBjgH9AlCniBA==',
        source: 'joox',
        title: '愛琴海'
      }
    })
  })

  it('uses the documented GD_MUSIC environment names', async () => {
    const fetcher = createFakeGdFetch({
      search: {
        joox: [
          {
            artist: ['周杰伦'],
            id: 'joox-1',
            name: '稻香',
            source: 'joox'
          }
        ]
      },
      urls: {
        'joox:joox-1': 'https://example.test/daoxiang.mp3'
      }
    })
    const provider = createGdStudioMusicProvider({
      env: {
        GD_MUSIC_API_BASE_URL: 'https://music-api.example.test/api.php',
        GD_MUSIC_DEFAULT_BR: '740',
        GD_MUSIC_SEARCH_COUNT: '2'
      },
      fetch: fetcher
    })

    await provider.play({ query: '稻香', sourcePreference: 'joox' })

    const searchUrl = new URL(fetcher.mock.calls[0][0].toString())
    const urlRequest = new URL(fetcher.mock.calls[1][0].toString())
    expect(searchUrl.origin).toBe('https://music-api.example.test')
    expect(searchUrl.searchParams.get('count')).toBe('2')
    expect(urlRequest.searchParams.get('br')).toBe('740')
  })
})
