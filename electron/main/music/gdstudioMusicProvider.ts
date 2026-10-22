export type MusicSource = 'netease' | 'kuwo' | 'joox'

export type MusicSourcePreference = 'all' | MusicSource

export type LyricLine = {
  timeMs: number
  text: string
}

export type MusicTrack = {
  id: string
  playbackId?: string
  lyricId?: string
  artworkId?: string
  source?: MusicSource
  title: string
  artist: string
  album?: string
  artworkUrl?: string
  audioUrl?: string
  durationMs: number
  lyrics?: LyricLine[]
  recommendation?: string
}

export type PlaybackState = {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error'
  track: MusicTrack | null
  positionMs: number
  durationMs: number | null
  errorMessage?: string
}

export type MusicSearchPayload = {
  query: string
  sourcePreference?: MusicSourcePreference
  refresh?: boolean
}

export type MusicSearchProgress = {
  tracks: MusicTrack[]
  sources: Array<{ source: MusicSource; status: 'searching' | 'ready' | 'empty' | 'unavailable' }>
}

export type MusicPlayPayload = {
  query?: string
  sourcePreference?: MusicSourcePreference
  excludeTrackKeys?: string[]
  trackId?: string
  playbackId?: string
  lyricId?: string
  artworkId?: string
  title?: string
  artist?: string
  album?: string
  artworkUrl?: string
  durationMs?: number
  source?: MusicSource
}

export type MusicProviderName = 'gdstudio'

export type MusicProvider = {
  close?(): void
  authorize(): Promise<{ authorized: boolean; provider: MusicProviderName }>
  getPlaybackState(): Promise<PlaybackState>
  pause(): Promise<PlaybackState>
  play(payload: MusicPlayPayload): Promise<PlaybackState>
  resume(): Promise<PlaybackState>
  search(payload: MusicSearchPayload, onProgress?: (progress: MusicSearchProgress) => void): Promise<{ tracks: MusicTrack[] }>
}

export type GdStudioProviderOptions = {
  timeoutMs?: number
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  now?: () => number
}

type GdStudioCandidate = MusicTrack & {
  source: MusicSource
  urlId: string
  lyricId?: string
  picId?: string
}

type SearchCacheEntry = {
  expiresAt: number
  tracks: GdStudioCandidate[]
}

const DEFAULT_API_BASE = 'https://music-api.gdstudio.xyz/api.php'
const DEFAULT_BITRATE = '320'
const DEFAULT_SEARCH_COUNT = '10'
const DEFAULT_SEARCH_PAGE = '1'
const DEFAULT_CACHE_TTL_MS = 300_000
const DEFAULT_SOURCE_ORDER: MusicSource[] = ['netease', 'kuwo', 'joox']
const NO_PLAYABLE_MESSAGE = '没有找到可播放的音乐，请换个关键词或音源再试试。'

function readEnv(
  env: Record<string, string | undefined>,
  key: string
): string {
  return env[key]?.trim() ?? ''
}

function readPositiveNumber(value: string, fallback: number): number {
  const parsed = Number(value)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function readString(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim()
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }

  return ''
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => readString(item))
      .filter((item) => item.length > 0)
  }

  const text = readString(value)

  return text ? [text] : []
}

function readDurationMs(value: Record<string, unknown>): number {
  const durationMs = Number(value.durationMs ?? value.duration_ms)

  if (Number.isFinite(durationMs) && durationMs > 0) {
    return Math.round(durationMs)
  }

  const seconds = Number(value.duration ?? value.interval)

  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0
}

function isMusicSource(value: unknown): value is MusicSource {
  return DEFAULT_SOURCE_ORDER.includes(value as MusicSource)
}

function normalizeSourcePreference(
  sourcePreference?: MusicSourcePreference
): MusicSource[] {
  if (isMusicSource(sourcePreference)) {
    return [sourcePreference]
  }

  return DEFAULT_SOURCE_ORDER
}

function createErrorState(message: string): PlaybackState {
  return {
    durationMs: null,
    errorMessage: message,
    positionMs: 0,
    status: 'error',
    track: null
  }
}

function getTrackKey(track: Pick<GdStudioCandidate, 'id' | 'source'>): string {
  return `${track.source}:${track.id}`
}

function toPublicTrack(track: GdStudioCandidate): MusicTrack {
  const publicTrack: MusicTrack = {
    album: track.album,
    artist: track.artist,
    artworkId: track.picId,
    artworkUrl: track.artworkUrl,
    audioUrl: track.audioUrl,
    durationMs: track.durationMs,
    id: track.id,
    lyricId: track.lyricId && track.lyricId !== track.id ? track.lyricId : undefined,
    lyrics: track.lyrics,
    playbackId: track.urlId && track.urlId !== track.id ? track.urlId : undefined,
    recommendation: track.recommendation,
    source: track.source,
    title: track.title
  }

  return Object.fromEntries(
    Object.entries(publicTrack).filter(([, value]) => value !== undefined)
  ) as MusicTrack
}

function readSearchItems(body: unknown): unknown[] {
  if (Array.isArray(body)) {
    return body
  }

  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>

    if (Array.isArray(record.data)) {
      return record.data
    }

    if (Array.isArray(record.result)) {
      return record.result
    }
  }

  return []
}

function normalizeCandidate(
  item: unknown,
  fallbackSource: MusicSource
): GdStudioCandidate | null {
  if (!item || typeof item !== 'object') {
    return null
  }

  const record = item as Record<string, unknown>
  const id = readString(record.id)
  const title = readString(record.name ?? record.title)
  const artists = readStringArray(record.artist ?? record.artists)
  const source = fallbackSource

  if (!id || !title || artists.length === 0) {
    return null
  }

  return {
    album: readString(record.album) || undefined,
    artworkUrl: /^https?:\/\//i.test(readString(record.pic ?? record.artworkUrl)) ? readString(record.pic ?? record.artworkUrl) : undefined,
    artist: artists.join(' / '),
    durationMs: readDurationMs(record),
    id,
    lyricId: readString(record.lyric_id ?? record.lyricId) || id,
    picId: readString(record.pic_id ?? record.picId) || undefined,
    recommendation: `来自 GD Studio ${source} 的搜索结果。`,
    source,
    title,
    urlId: readString(record.url_id ?? record.urlId) || id
  }
}

export function parseLrc(lyric: string): LyricLine[] {
  const lines: LyricLine[] = []

  for (const rawLine of lyric.split(/\r?\n/)) {
    const matches = [...rawLine.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)]

    if (matches.length === 0) {
      continue
    }

    const text = rawLine.slice((matches.at(-1)?.index ?? 0) + (matches.at(-1)?.[0].length ?? 0)).trim()

    if (!text) {
      continue
    }

    for (const match of matches) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      const fraction = match[3] ?? '0'
      const milliseconds = Math.round(Number(`0.${fraction}`) * 1000)

      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
        continue
      }

      lines.push({
        text,
        timeMs: minutes * 60_000 + seconds * 1000 + milliseconds
      })
    }
  }

  return lines.sort((left, right) => left.timeMs - right.timeMs)
}

export function createGdStudioMusicProvider(
  options: GdStudioProviderOptions = {}
): MusicProvider {
  const env = options.env ?? process.env
  const fetcher = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const apiBase =
    readEnv(env, 'GD_MUSIC_API_BASE_URL') || DEFAULT_API_BASE
  const bitrate =
    readEnv(env, 'GD_MUSIC_DEFAULT_BR') || DEFAULT_BITRATE
  const searchCount = String(Math.max(1, Math.min(50, Math.floor(readPositiveNumber(
    readEnv(env, 'GD_MUSIC_SEARCH_COUNT'), Number(DEFAULT_SEARCH_COUNT)
  )))))
  const cacheTtlMs = readPositiveNumber(
    readEnv(env, 'GD_MUSIC_CACHE_TTL_MS'),
    DEFAULT_CACHE_TTL_MS
  )
  const searchCache = new Map<string, SearchCacheEntry>()
  const searchInFlight = new Map<string, Promise<GdStudioCandidate[]>>()
  // The upstream aggregator can stop supporting a source (e.g. HTTP 400
  // "source is not supported"). Avoid probing a dead source on every search;
  // an explicit single-source request still retries once the user asks.
  const sourceUnavailableUntil = new Map<MusicSource, number>()
  const SOURCE_RETRY_MS = 10 * 60_000
  const requests = new Set<AbortController>()
  let closed = false
  let playback: PlaybackState = {
    durationMs: null,
    positionMs: 0,
    status: 'idle',
    track: null
  }

  class ProviderHttpError extends Error {
    constructor(readonly status: number) { super('MUSIC_PROVIDER_HTTP_FAILED'); this.name = 'ProviderHttpError' }
  }
  async function requestJson(url: URL, timeoutMs = options.timeoutMs ?? 8000): Promise<unknown> {
    if (closed) throw new Error('MUSIC_PROVIDER_CLOSED')
    const controller = new AbortController(); requests.add(controller)
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetcher(url.toString(), { signal: controller.signal })
      if (!response.ok) throw new ProviderHttpError(response.status)
      return await response.json()
    } finally { clearTimeout(timer); requests.delete(controller) }
  }

  function buildUrl(params: Record<string, string>): URL {
    const url = new URL(apiBase)

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }

    return url
  }

  async function searchSource(
    query: string,
    source: MusicSource,
    respectBackoff = true,
    refresh = false
  ): Promise<GdStudioCandidate[]> {
    const cacheKey = `${source}:${query.toLowerCase()}`
    const cached = searchCache.get(cacheKey)

    if (!refresh && cached && cached.expiresAt > now()) {
      return cached.tracks
    }
    if (respectBackoff && (sourceUnavailableUntil.get(source) ?? 0) > now()) throw new Error('MUSIC_PROVIDER_SOURCE_UNAVAILABLE')

    const inFlight = searchInFlight.get(cacheKey)
    if (inFlight) return inFlight
    const pending = loadSearchSource(query, source, cacheKey).finally(() => searchInFlight.delete(cacheKey))
    searchInFlight.set(cacheKey, pending)
    return pending
  }

  async function loadSearchSource(query: string, source: MusicSource, cacheKey: string): Promise<GdStudioCandidate[]> {
    let body: unknown
    try {
      body = await requestJson(buildUrl({
        count: searchCount,
        name: query,
        pages: DEFAULT_SEARCH_PAGE,
        source,
        types: 'search'
      }), Math.min(options.timeoutMs ?? 6000, 6000))
    } catch (error) {
      if (error instanceof ProviderHttpError && [400, 404, 410].includes(error.status)) {
        sourceUnavailableUntil.set(source, now() + SOURCE_RETRY_MS)
      } else if (!closed) {
        sourceUnavailableUntil.set(source, now() + 30_000)
      }
      throw error
    }
    const tracks = readSearchItems(body)
      .map((item) => normalizeCandidate(item, source))
      .filter((track): track is GdStudioCandidate => track !== null)
      .slice(0, Number(searchCount))
    // Search only needs metadata. Cover/URL/lyrics resolve once a song is played;
    // one slow cover must never hold every result behind it.
    sourceUnavailableUntil.delete(source)
    if (searchCache.size >= 100) searchCache.delete(searchCache.keys().next().value!)
    searchCache.set(cacheKey, {
      expiresAt: now() + (tracks.length ? cacheTtlMs : Math.min(cacheTtlMs, 30_000)),
      tracks
    })

    return tracks
  }

  async function trySearchSource(
    query: string,
    source: MusicSource
  ): Promise<GdStudioCandidate[]> {
    try {
      return await searchSource(query, source)
    } catch {
      return []
    }
  }

  async function searchCandidates(payload: MusicSearchPayload, onProgress?: (progress: MusicSearchProgress) => void): Promise<GdStudioCandidate[]> {
    const query = payload.query.trim()
    const tracks: GdStudioCandidate[] = []
    let successes = 0

    const preference = normalizeSourcePreference(payload.sourcePreference)
    const respectBackoff = !payload.refresh && !isMusicSource(payload.sourcePreference)
    const bySource = new Map<MusicSource, GdStudioCandidate[]>()
    const sources: MusicSearchProgress['sources'] = preference.map(source => ({ source, status: 'searching' }))
    const publish = () => {
      try { onProgress?.({ tracks: preference.flatMap(source => bySource.get(source) ?? []).map(toPublicTrack), sources: sources.map(value => ({ ...value })) }) }
      catch { /* Progress observation cannot fail a search. */ }
    }
    publish()
    await Promise.all(preference.map(async (source, index) => {
      try {
        const found = await searchSource(query, source, respectBackoff, payload.refresh === true)
        bySource.set(source, found); successes++
        sources[index].status = found.length ? 'ready' : 'empty'
      } catch { sources[index].status = 'unavailable' }
      publish()
    }))
    tracks.push(...preference.flatMap(source => bySource.get(source) ?? []))

    if (!successes) throw new Error('MUSIC_PROVIDER_UNAVAILABLE')
    return tracks
  }

  async function resolveAudioUrl(track: GdStudioCandidate): Promise<string> {
    const body = await requestJson(
      buildUrl({
        br: bitrate,
        id: track.urlId,
        source: track.source,
        types: 'url'
      })
    )

    if (typeof body === 'string') {
      return body.trim()
    }

    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>

      return readString(record.url)
    }

    return ''
  }

  async function resolveArtworkUrl(track: GdStudioCandidate): Promise<string | undefined> {
    if (!track.picId) {
      return undefined
    }

    const body = await requestJson(
      buildUrl({
        id: track.picId,
        size: '500',
        source: track.source,
        types: 'pic'
      })
    )

    if (typeof body === 'string') {
      return body.trim() || undefined
    }

    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>

      return readString(record.url) || undefined
    }

    return undefined
  }

  async function resolveLyrics(track: GdStudioCandidate): Promise<LyricLine[] | undefined> {
    if (!track.lyricId) {
      return undefined
    }

    const body = await requestJson(
      buildUrl({
        id: track.lyricId,
        source: track.source,
        types: 'lyric'
      })
    )

    if (!body || typeof body !== 'object') {
      return undefined
    }

    const record = body as Record<string, unknown>
    const lines = parseLrc(readString(record.lyric) || readString(record.tlyric))

    return lines.length > 0 ? lines : undefined
  }

  async function tryResolveAudioUrl(track: GdStudioCandidate): Promise<string> {
    try {
      return await resolveAudioUrl(track)
    } catch {
      return ''
    }
  }

  async function tryResolveArtworkUrl(track: GdStudioCandidate): Promise<string | undefined> {
    if (track.artworkUrl) {
      return track.artworkUrl
    }

    try {
      return await resolveArtworkUrl(track)
    } catch {
      return undefined
    }
  }

  async function tryResolveLyrics(track: GdStudioCandidate): Promise<LyricLine[] | undefined> {
    try {
      return await resolveLyrics(track)
    } catch {
      return undefined
    }
  }

  function createTrackPayload(payload: MusicPlayPayload): GdStudioCandidate | null {
    const trackId = payload.trackId?.trim()
    const playbackId = payload.playbackId?.trim() || trackId
    const source = payload.source

    if (!trackId || !playbackId || !isMusicSource(source)) {
      return null
    }

    const cachedTrack = [...searchCache.values()]
      .flatMap((entry) => entry.tracks)
      .find((track) => track.source === source && track.id === trackId)
    const durationMs = Number(payload.durationMs)

    return {
      album: payload.album?.trim() || cachedTrack?.album,
      artist: payload.artist?.trim() || cachedTrack?.artist || '未知歌手',
      artworkUrl: payload.artworkUrl?.trim() || cachedTrack?.artworkUrl,
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0,
      id: trackId,
      lyricId: payload.lyricId?.trim() || cachedTrack?.lyricId || trackId,
      picId: payload.artworkId?.trim() || cachedTrack?.picId,
      recommendation: `来自 GD Studio ${source} 的搜索结果。`,
      source,
      title: payload.title?.trim() || cachedTrack?.title || trackId,
      urlId: playbackId
    }
  }

  async function resolvePlayableTrack(
    payload: MusicPlayPayload
  ): Promise<MusicTrack | null> {
    const excluded = new Set(payload.excludeTrackKeys ?? [])
    const query = payload.query?.trim()

    if (query) {
      for (const source of normalizeSourcePreference(payload.sourcePreference)) {
        const candidates = await trySearchSource(query, source)

        for (const candidate of candidates) {
          if (excluded.has(getTrackKey(candidate))) {
            continue
          }

          const audioUrl = await tryResolveAudioUrl(candidate)

          if (!audioUrl) {
            continue
          }

          const [artworkUrl, lyrics] = await Promise.all([
            tryResolveArtworkUrl(candidate),
            tryResolveLyrics(candidate)
          ])

          return toPublicTrack({
            ...candidate,
            artworkUrl,
            audioUrl,
            lyrics
          })
        }
      }

      return null
    }

    const candidate = createTrackPayload(payload)

    if (!candidate || excluded.has(getTrackKey(candidate))) {
      return null
    }

    const audioUrl = await tryResolveAudioUrl(candidate)

    if (!audioUrl) {
      return null
    }

    const [artworkUrl, lyrics] = await Promise.all([
      tryResolveArtworkUrl(candidate),
      tryResolveLyrics(candidate)
    ])

    return toPublicTrack({
      ...candidate,
      artworkUrl: artworkUrl ?? candidate.artworkUrl,
      audioUrl,
      lyrics
    })
  }

  return {
    close() { closed = true; for (const controller of requests) controller.abort(); requests.clear() },
    async authorize() {
      return {
        authorized: true,
        provider: 'gdstudio'
      }
    },

    async getPlaybackState() {
      return playback
    },

    async pause() {
      if (playback.track) {
        playback = {
          ...playback,
          status: 'paused'
        }
      }

      return playback
    },

    async play(payload) {
      const track = await resolvePlayableTrack(payload)

      if (!track) {
        playback = createErrorState(NO_PLAYABLE_MESSAGE)
        return playback
      }

      playback = {
        durationMs: track.durationMs,
        positionMs: 0,
        status: 'playing',
        track
      }

      return playback
    },

    async resume() {
      if (playback.track) {
        playback = {
          ...playback,
          status: 'playing'
        }
      }

      return playback
    },

    async search(payload, onProgress) {
      return {
        tracks: (await searchCandidates(payload, onProgress)).map(toPublicTrack)
      }
    }
  }
}
