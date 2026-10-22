import type { MusicTrack } from '../types/app'

export type MusicResultGroup = { key: string; primary: MusicTrack; versions: MusicTrack[] }

// Keep version words (live/remix/cover etc.) and artist identities: a same-title
// cover must never replace the artist the user asked for.
function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s·・•]+/g, ' ').trim()
}

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
  const tokens = normalized(query).split(' ').filter(Boolean)
  const score = (track: MusicTrack) => {
    const title = normalized(track.title), artist = normalized(track.artist)
    return tokens.reduce((total, token) => total + (title === token ? 6 : title.includes(token) ? 3 : 0) + (artist === token ? 5 : artist.includes(token) ? 2 : 0), 0)
  }
  return [...groups.values()].sort((left, right) => score(right.primary) - score(left.primary))
}

export const musicSourceLabel = (source?: string): string => ({ netease: '网易云', kuwo: '酷我', joox: 'JOOX' }[source ?? ''] ?? '其他音源')
