import type { MusicTrack } from '../types/app'

export type MusicResultGroup = { key: string; primary: MusicTrack; versions: MusicTrack[] }

import { musicText as normalized, musicRelevance } from '../../electron/shared/musicMatching'

export function groupMusicResults(tracks: MusicTrack[], query: string): MusicResultGroup[] {
  const groups = new Map<string, MusicResultGroup>(), seen = new Set<string>()
  for (const track of tracks) {
    const identity = `${track.source ?? 'unknown'}:${track.id}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const key = `${normalized(track.title)}\u0000${normalized(track.artist)}`
    const group = groups.get(key)
    if (group) group.versions.push(track)
    else groups.set(key, { key, primary: track, versions: [track] })
  }
  return [...groups.values()].sort((left, right) => musicRelevance(right.primary, query) - musicRelevance(left.primary, query))
}

export const musicSourceLabel = (source?: string): string => ({ netease: '网易云', kuwo: '酷我', joox: 'JOOX' }[source ?? ''] ?? '其他音源')
