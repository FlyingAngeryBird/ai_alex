import { createRequire } from 'node:module'
import {
  createGdStudioMusicProvider,
  type GdStudioProviderOptions,
  type MusicPlayPayload,
  type MusicProvider,
  type MusicSearchPayload,
  type MusicSource,
  type MusicSourcePreference,
  type MusicTrack,
} from '../music/gdstudioMusicProvider.js'
import { getDefaultMusicStore, type MusicLibraryStore } from '../music/musicStore.js'

type AppResult<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: {
        code: string
        message: string
      }
    }

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
}

type ElectronRuntime = {
  ipcMain: IpcMainLike
}

const require = createRequire(import.meta.url)
const musicSources: MusicSource[] = ['netease', 'kuwo', 'joox']

function ok<T>(data: T): AppResult<T> {
  return {
    data,
    ok: true
  }
}

function fail(code: string, message: string): AppResult<never> {
  return {
    error: {
      code,
      message
    },
    ok: false
  }
}

function isMusicSource(value: unknown): value is MusicSource {
  return musicSources.includes(value as MusicSource)
}

function isSourcePreference(value: unknown): value is MusicSourcePreference {
  return value === 'all' || isMusicSource(value)
}

function normalizeSourcePreference(value: unknown): MusicSourcePreference | undefined {
  return isSourcePreference(value) ? value : undefined
}

function normalizeExcludeTrackKeys(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const keys = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)

  return keys.length > 0 ? keys : undefined
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizePositiveNumber(value: unknown): number | undefined {
  const number = Number(value)

  return Number.isFinite(number) && number > 0 ? Math.round(number) : undefined
}

function normalizeSearchPayload(payload: unknown): MusicSearchPayload | null {
  const value = payload as Partial<MusicSearchPayload> | null
  const query = typeof value?.query === 'string' ? value.query.trim() : ''

  if (!query) {
    return null
  }

  return {
    query,
    sourcePreference: normalizeSourcePreference(value?.sourcePreference)
  }
}

function normalizePlayPayload(payload: unknown): MusicPlayPayload | null {
  const value = payload as Partial<MusicPlayPayload> | null
  const query = typeof value?.query === 'string' ? value.query.trim() : ''
  const trackId = typeof value?.trackId === 'string' ? value.trackId.trim() : ''
  const source = isMusicSource(value?.source) ? value.source : undefined

  if (!query && !trackId) {
    return null
  }

  return {
    album: normalizeString(value?.album),
    artist: normalizeString(value?.artist),
    artworkId: normalizeString(value?.artworkId),
    artworkUrl: normalizeString(value?.artworkUrl),
    durationMs: normalizePositiveNumber(value?.durationMs),
    excludeTrackKeys: normalizeExcludeTrackKeys(value?.excludeTrackKeys),
    lyricId: normalizeString(value?.lyricId),
    playbackId: normalizeString(value?.playbackId),
    query: query || undefined,
    source,
    sourcePreference: normalizeSourcePreference(value?.sourcePreference),
    title: normalizeString(value?.title),
    trackId: trackId || undefined
  }
}

function getIpcMain(): IpcMainLike {
  const electron = require('electron') as ElectronRuntime

  return electron.ipcMain
}

export function createConfiguredMusicProvider(
  options: GdStudioProviderOptions = {}
): MusicProvider {
  return createGdStudioMusicProvider(options)
}

function isFavoritePayload(payload: unknown): payload is MusicTrack {
  if (!payload || typeof payload !== 'object') {
    return false
  }

  const value = payload as Record<string, unknown>

  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.artist === 'string'
  )
}

export function registerMusicHandlers(
  ipc: IpcMainLike = getIpcMain(),
  provider: MusicProvider = createConfiguredMusicProvider(),
  library: MusicLibraryStore = getDefaultMusicStore()
): void {
  ipc.handle('music.authorize', async () => ok(await provider.authorize()))
  ipc.handle('music.getPlaybackState', async () => ok(await provider.getPlaybackState()))
  ipc.handle('music.pause', async () => ok(await provider.pause()))
  ipc.handle('music.resume', async () => ok(await provider.resume()))

  ipc.handle('music.search', async (_event, payload) => {
    const searchPayload = normalizeSearchPayload(payload)

    if (!searchPayload) {
      return fail('MUSIC_INVALID_PAYLOAD', '音乐搜索关键词不能为空')
    }

    try {
      return ok(await provider.search(searchPayload))
    } catch (error) {
      return fail(
        'MUSIC_SEARCH_FAILED',
        error instanceof Error ? error.message : '音乐搜索失败'
      )
    }
  })

  ipc.handle('music.play', async (_event, payload) => {
    const playPayload = normalizePlayPayload(payload)

    if (!playPayload) {
      return fail('MUSIC_INVALID_PAYLOAD', '音乐播放参数不正确')
    }

    try {
      return ok(await provider.play(playPayload))
    } catch (error) {
      return fail(
        'MUSIC_PLAY_FAILED',
        error instanceof Error ? error.message : '音乐播放失败'
      )
    }
  })

  ipc.handle('music.getLibrary', () => ok(library.getLibrary()))

  ipc.handle('music.toggleFavorite', async (_event, payload) => {

    if (!isFavoritePayload(payload)) {
      return fail('MUSIC_INVALID_PAYLOAD', '收藏参数不正确')
    }

    try {
      const favorites = await library.toggleFavorite(payload)
      return ok(favorites)
    } catch (error) {
      return fail(
        'MUSIC_FAVORITE_FAILED',
        error instanceof Error ? error.message : '收藏操作失败'
      )
    }
  })

  ipc.handle('music.addSearchHistory', async (_event, payload) => {
    const query =
      typeof (payload as { query?: unknown })?.query === 'string'
        ? (payload as { query: string }).query
        : ''

    if (!query.trim()) {
      return fail('MUSIC_INVALID_PAYLOAD', '搜索历史关键词不能为空')
    }

    try {
      return ok(await library.addSearchHistory(query))
    } catch (error) {
      return fail(
        'MUSIC_HISTORY_FAILED',
        error instanceof Error ? error.message : '搜索历史更新失败'
      )
    }
  })

  ipc.handle('music.clearSearchHistory', async () => {
    try {
      return ok(await library.clearSearchHistory())
    } catch (error) {
      return fail(
        'MUSIC_HISTORY_FAILED',
        error instanceof Error ? error.message : '搜索历史清除失败'
      )
    }
  })
}
