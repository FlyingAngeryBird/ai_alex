import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MusicSource, MusicTrack } from './gdstudioMusicProvider.js'

export type MusicLibrary = {
  favorites: MusicTrack[]
  searchHistory: string[]
}

export type MusicLibraryStore = {
  loadLibrary(): Promise<MusicLibrary>
  getLibrary(): MusicLibrary
  toggleFavorite(track: MusicTrack): Promise<MusicTrack[]>
  addSearchHistory(query: string): Promise<string[]>
  clearSearchHistory(): Promise<string[]>
}

type MusicStoreOptions = {
  filePath: string
  fs?: {
    readFile(path: string, encoding: string): Promise<string>
    writeFile(path: string, data: string, encoding: string): Promise<void>
    mkdir(path: string, options: { recursive: boolean }): Promise<unknown>
  }
}

const SEARCH_HISTORY_LIMIT = 8
const MUSIC_SOURCES: readonly string[] = ['netease', 'kuwo', 'joox']

export function getTrackKey(track: { id: string; source?: string }): string {
  return `${track.source ?? 'unknown'}:${track.id}`
}

function createDefaultLibrary(): MusicLibrary {
  return { favorites: [], searchHistory: [] }
}

function isMusicSource(value: unknown): value is MusicSource {
  return typeof value === 'string' && MUSIC_SOURCES.includes(value)
}

// 收藏只保留播放所需字段，丢弃 audioUrl/lyrics（临时的、体积大）
function normalizeTrack(track: unknown): MusicTrack | null {
  if (!track || typeof track !== 'object') {
    return null
  }

  const value = track as Record<string, unknown>

  if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.artist !== 'string') {
    return null
  }

  const normalized: MusicTrack = {
    id: value.id,
    title: value.title,
    artist: value.artist,
    album: typeof value.album === 'string' ? value.album : undefined,
    artworkUrl: typeof value.artworkUrl === 'string' ? value.artworkUrl : undefined,
    artworkId: typeof value.artworkId === 'string' ? value.artworkId : undefined,
    playbackId: typeof value.playbackId === 'string' ? value.playbackId : undefined,
    lyricId: typeof value.lyricId === 'string' ? value.lyricId : undefined,
    source: isMusicSource(value.source) ? value.source : undefined,
    durationMs: typeof value.durationMs === 'number' ? value.durationMs : 0
  }

  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== undefined)
  ) as MusicTrack
}

function migrateLibrary(defaults: MusicLibrary, parsed: unknown): MusicLibrary {
  if (!parsed || typeof parsed !== 'object') {
    return defaults
  }

  const record = parsed as Record<string, unknown>
  const favorites = Array.isArray(record.favorites)
    ? record.favorites.map(normalizeTrack).filter((track): track is MusicTrack => track !== null)
    : []
  const searchHistory = Array.isArray(record.searchHistory)
    ? record.searchHistory.filter((query): query is string => typeof query === 'string')
    : []

  return { favorites, searchHistory }
}

export function createMusicStore(options: MusicStoreOptions): MusicLibraryStore {
  const fs = options.fs ?? {
    readFile: (path, encoding) => readFile(path, encoding as BufferEncoding),
    writeFile: (path, data, encoding) => writeFile(path, data, encoding as BufferEncoding),
    mkdir: (path, opts) => mkdir(path, opts)
  }
  let cache: MusicLibrary = createDefaultLibrary()

  async function persist(): Promise<void> {
    const data = JSON.stringify(cache, null, 2)
    await fs.mkdir(dirname(options.filePath), { recursive: true })
    await fs.writeFile(options.filePath, data, 'utf8')
  }

  async function loadLibrary(): Promise<MusicLibrary> {
    try {
      const raw = await fs.readFile(options.filePath, 'utf8')
      cache = migrateLibrary(createDefaultLibrary(), JSON.parse(raw))
    } catch {
      cache = createDefaultLibrary()
    }
    return cache
  }

  function getLibrary(): MusicLibrary {
    return cache
  }

  async function toggleFavorite(track: MusicTrack): Promise<MusicTrack[]> {
    const key = getTrackKey(track)
    const existing = cache.favorites.findIndex((item) => getTrackKey(item) === key)

    if (existing >= 0) {
      cache = {
        ...cache,
        favorites: cache.favorites.filter((_, index) => index !== existing)
      }
    } else {
      const normalized = normalizeTrack(track) ?? track
      cache = {
        ...cache,
        favorites: [...cache.favorites, normalized]
      }
    }

    await persist()
    return cache.favorites
  }

  async function addSearchHistory(query: string): Promise<string[]> {
    const trimmed = query.trim()

    if (!trimmed) {
      return cache.searchHistory
    }

    const deduped = cache.searchHistory.filter((item) => item !== trimmed)
    cache = {
      ...cache,
      searchHistory: [trimmed, ...deduped].slice(0, SEARCH_HISTORY_LIMIT)
    }

    await persist()
    return cache.searchHistory
  }

  async function clearSearchHistory(): Promise<string[]> {
    cache = { ...cache, searchHistory: [] }
    await persist()
    return cache.searchHistory
  }

  return { loadLibrary, getLibrary, toggleFavorite, addSearchHistory, clearSearchHistory }
}

let defaultStore: MusicLibraryStore | null = null

export function initDefaultMusicStore(filePath: string): MusicLibraryStore {
  defaultStore = createMusicStore({ filePath })
  return defaultStore
}

export function getDefaultMusicStore(): MusicLibraryStore {
  if (!defaultStore) {
    defaultStore = createMusicStore({ filePath: '<memory-default>' })
  }
  return defaultStore
}
