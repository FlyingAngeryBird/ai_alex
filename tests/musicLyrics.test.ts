import { describe, expect, it } from 'vitest'
import type { MusicTrack } from '../src/types/app'
import { getCurrentLyricIndex } from '../src/utils/musicLyrics'

describe('music lyric timeline helpers', () => {
  it('returns -1 when there are no lyric lines', () => {
    expect(getCurrentLyricIndex([], 1200)).toBe(-1)
    expect(getCurrentLyricIndex(undefined, 1200)).toBe(-1)
  })

  it('returns -1 before the first timed lyric line starts', () => {
    expect(getCurrentLyricIndex([{ timeMs: 1000, text: '第一句' }], 999)).toBe(-1)
  })

  it('returns the current line for the playback position', () => {
    expect(
      getCurrentLyricIndex(
        [
          { timeMs: 1000, text: '第一句' },
          { timeMs: 2500, text: '第二句' },
          { timeMs: 4200, text: '第三句' }
        ],
        2600
      )
    ).toBe(1)
  })

  it('keeps the last line active after the final timestamp', () => {
    expect(
      getCurrentLyricIndex(
        [
          { timeMs: 1000, text: '第一句' },
          { timeMs: 2500, text: '第二句' }
        ],
        8000
      )
    ).toBe(1)
  })

  it('supports playable music tracks with source, audio url, and timed lyrics', () => {
    const track: MusicTrack = {
      audioUrl: 'https://example.test/song.mp3',
      artist: '周杰伦',
      durationMs: 0,
      id: 'joox-1',
      lyrics: [{ timeMs: 1000, text: '第一句' }],
      source: 'joox',
      title: '稻香'
    }

    expect(track.source).toBe('joox')
    expect(track.audioUrl).toBe('https://example.test/song.mp3')
    expect(track.lyrics?.[0]).toEqual({ timeMs: 1000, text: '第一句' })
  })
})
