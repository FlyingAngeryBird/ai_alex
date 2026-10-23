import { describe, expect, it } from 'vitest'
import { groupMusicResults } from '../src/utils/musicSearchResults'
import type { MusicTrack } from '../src/types/app'

const track = (id: string, source: MusicTrack['source'], title = '告白气球', artist = '周杰伦'): MusicTrack => ({ id, source, title, artist, durationMs: 0 })
describe('music search presentation', () => {
  it('matches simplified/traditional names and compact artist-title queries ahead of covers and live recordings', () => {
    const groups = groupMusicResults([track('cover','netease','告白气球','Xai小爱'),track('live','netease','告白气球 (Live)'),track('original','joox','告白氣球','周杰倫'),track('cn','netease')], '告白气球周杰伦')
    expect(groups[0].versions.map(value => value.id)).toEqual(['original','cn'])
    expect(groups).toHaveLength(3)
  })
  it('groups the same artist/recording across sources without dropping any distinct result or merging covers/live versions', () => {
    const tracks = [track('1', 'netease'), track('2', 'joox'), track('3', 'netease', '告白气球', '另一位歌手'), track('4', 'joox', '告白气球 (Live)'), track('5', 'netease', '其他歌曲'), track('1', 'netease')]
    const groups = groupMusicResults(tracks, '告白气球 周杰伦')
    expect(groups).toHaveLength(4)
    expect(groups[0].versions.map(value => `${value.source}:${value.id}`)).toEqual(['netease:1', 'joox:2'])
    expect(groups.flatMap(group => group.versions)).toHaveLength(5)
    expect(groups.some(group => group.primary.artist === '另一位歌手' && group.versions.length === 1)).toBe(true)
    expect(groups.some(group => group.primary.title.includes('Live') && group.versions.length === 1)).toBe(true)
  })
})
