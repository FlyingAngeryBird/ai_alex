// Real public provider metadata/URL checks only. No music audio is downloaded or played.
import { createGdStudioMusicProvider } from '../dist-electron/main/music/gdstudioMusicProvider.js'
const outcomes = await Promise.all(['netease', 'kuwo', 'joox'].map(async source => {
  const http = [], provider = createGdStudioMusicProvider({ env: { GD_MUSIC_API_BASE_URL: 'https://music-api.gdstudio.xyz/api.php' }, timeoutMs: 8000,
    fetch: async (url, init) => { const response = await fetch(url, init); http.push(response.status); return response } })
  const start = performance.now()
  try {
    const result = await provider.search({ query: '晴天 周杰伦', sourcePreference: source })
    const selected = result.tracks.find(track => track.title === '晴天' && ['周杰伦', '周杰倫'].includes(track.artist.replace(/\s+/g, '')))
    if (!selected) return { source, status: 'no_exact_candidate', candidates: result.tracks.length,
      samples: result.tracks.slice(0, 5).map(track => ({ title: track.title, artist: track.artist, source: track.source })), http, elapsedMs: Math.round(performance.now() - start) }
    const resource = await provider.play({ source: selected.source, trackId: selected.id, playbackId: selected.playbackId, title: selected.title, artist: selected.artist,
      artworkId: selected.artworkId, lyricId: selected.lyricId, durationMs: selected.durationMs })
    return { source, status: resource.track?.audioUrl ? 'url_resolved' : 'resource_unavailable', title: selected.title, artist: selected.artist,
      coverAvailable: !!resource.track?.artworkUrl, lrcAvailable: !!resource.track?.lyrics?.length, http, elapsedMs: Math.round(performance.now() - start) }
  } catch (error) { return { source, status: 'failed', code: /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'MUSIC_RESOURCE_CHECK_FAILED', http, elapsedMs: Math.round(performance.now() - start) } }
  finally { provider.close() }
}))
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), scope: 'real_provider_metadata_and_url_only', audioPlayed: false, installationVerified: false, outcomes }))
