import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  createConfiguredMusicProvider,
  registerMusicHandlers
} from '../electron/main/ipc/musicHandlers'

describe('music IPC handlers', () => {
  it('searches, plays, pauses, and resumes through the music provider', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }
    const provider = {
      authorize: vi.fn(async () => ({
        authorized: true,
        provider: 'gdstudio' as const
      })),
      getPlaybackState: vi.fn(async () => ({
        durationMs: null,
        positionMs: 0,
        status: 'idle' as const,
        track: null
      })),
      pause: vi.fn(async () => ({
        durationMs: 120000,
        positionMs: 0,
        status: 'paused' as const,
        track: {
          artist: '周杰伦',
          durationMs: 120000,
          id: 'track-1',
          title: '稻香'
        }
      })),
      play: vi.fn(async () => ({
        durationMs: 120000,
        positionMs: 0,
        status: 'playing' as const,
        track: {
          artist: '周杰伦',
          durationMs: 120000,
          id: 'track-1',
          title: '稻香'
        }
      })),
      resume: vi.fn(async () => ({
        durationMs: 120000,
        positionMs: 0,
        status: 'playing' as const,
        track: {
          artist: '周杰伦',
          durationMs: 120000,
          id: 'track-1',
          title: '稻香'
        }
      })),
      search: vi.fn(async () => ({
        tracks: [
          {
            artist: '周杰伦',
            durationMs: 120000,
            id: 'track-1',
            source: 'kuwo' as const,
            title: '稻香'
          }
        ]
      }))
    }

    registerMusicHandlers(ipcMain, provider)

    await expect(
      handlers.get('music.search')?.(null, { query: '轻松音乐', sourcePreference: 'kuwo' })
    ).resolves.toEqual({
      data: {
        tracks: [
          {
            artist: '周杰伦',
            durationMs: 120000,
            id: 'track-1',
            source: 'kuwo',
            title: '稻香'
          }
        ]
      },
      ok: true
    })
    await expect(
      handlers.get('music.play')?.(null, {
        excludeTrackKeys: ['kuwo:track-0'],
        query: '轻松音乐',
        sourcePreference: 'kuwo'
      })
    ).resolves.toEqual({
      data: expect.objectContaining({
        status: 'playing'
      }),
      ok: true
    })
    await expect(handlers.get('music.pause')?.(null)).resolves.toEqual({
      data: expect.objectContaining({
        status: 'paused'
      }),
      ok: true
    })
    await expect(handlers.get('music.resume')?.(null)).resolves.toEqual({
      data: expect.objectContaining({
        status: 'playing'
      }),
      ok: true
    })
    expect(provider.search).toHaveBeenCalledWith({
      query: '轻松音乐',
      sourcePreference: 'kuwo'
    })
    expect(provider.play).toHaveBeenCalledWith({
      excludeTrackKeys: ['kuwo:track-0'],
      query: '轻松音乐',
      sourcePreference: 'kuwo'
    })
  })

  it('keeps trackId/source play payloads compatible', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }
    const provider = {
      authorize: vi.fn(),
      getPlaybackState: vi.fn(),
      pause: vi.fn(),
      play: vi.fn(async () => ({
        durationMs: 120000,
        positionMs: 0,
        status: 'playing' as const,
        track: {
          artist: '周杰伦',
          durationMs: 120000,
          id: 'kuwo-1',
          source: 'kuwo' as const,
          title: '稻香'
        }
      })),
      resume: vi.fn(),
      search: vi.fn()
    }

    registerMusicHandlers(ipcMain, provider)

    await expect(
      handlers.get('music.play')?.(null, { source: 'kuwo', trackId: 'kuwo-1' })
    ).resolves.toEqual({
      data: expect.objectContaining({
        status: 'playing'
      }),
      ok: true
    })
    expect(provider.play).toHaveBeenCalledWith({
      source: 'kuwo',
      trackId: 'kuwo-1'
    })
  })

  it('rejects empty search and play payloads', async () => {
    const handlers = new Map<string, (_event: unknown, payload?: unknown) => Promise<unknown> | unknown>()
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      })
    }

    registerMusicHandlers(ipcMain)

    await expect(handlers.get('music.search')?.(null, { query: ' ' })).resolves.toEqual({
      error: {
        code: 'MUSIC_INVALID_PAYLOAD',
        message: '音乐搜索关键词不能为空'
      },
      ok: false
    })
    await expect(handlers.get('music.play')?.(null, { trackId: '' })).resolves.toEqual({
      error: {
        code: 'MUSIC_INVALID_PAYLOAD',
        message: '音乐播放参数不正确'
      },
      ok: false
    })
  })

  it('selects GD Studio as the configured provider when requested', async () => {
    const provider = createConfiguredMusicProvider({
      env: {
        MUSIC_PROVIDER: 'gdstudio'
      },
      fetch: vi.fn()
    })

    await expect(provider.authorize()).resolves.toEqual({
      authorized: true,
      provider: 'gdstudio'
    })
  })

  it('uses GD Studio as the only configured provider even when legacy preview env is present', async () => {
    const provider = createConfiguredMusicProvider({
      env: {}
    })

    await expect(provider.authorize()).resolves.toEqual({
      authorized: true,
      provider: 'gdstudio'
    })

    const providerWithLegacyPreviewEnv = createConfiguredMusicProvider({
      env: {
        MUSIC_PROVIDER: ['local', 'preview'].join('-')
      },
      fetch: vi.fn()
    })

    await expect(providerWithLegacyPreviewEnv.authorize()).resolves.toEqual({
      authorized: true,
      provider: 'gdstudio'
    })
  })

  it('does not contain Apple Music provider logic or user-facing errors', async () => {
    const source = await readFile('electron/main/ipc/musicHandlers.ts', 'utf8')

    expect(source).not.toMatch(/Apple Music|MusicKit|APPLE_MUSIC|apple-music/)
  })
})
