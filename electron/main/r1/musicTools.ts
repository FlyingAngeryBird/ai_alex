import { randomUUID } from 'node:crypto'
import { musicAliases, musicTrackView, type R1Music, type MusicScope } from './music.js'

/** Per-run observed identities; a guessed key or version is never authorization. */
export class R1MusicTools {
  private known = new Set<string>()
  private playerVersion: number | null = null
  private queueVersion: number | null = null
  constructor(private readonly music: R1Music, private readonly scope: MusicScope) {}
  observe(data: Record<string, unknown>): void {
    const tracks = data.tracks as Array<{ trackKey: string }> | undefined
    for (const track of tracks ?? []) this.known.add(track.trackKey)
    for (const feedback of data.feedback as Array<{ track: { trackKey: string } | null }> | undefined ?? []) if (feedback.track) this.known.add(feedback.track.trackKey)
    const state = data.state as ReturnType<R1Music['state']> | undefined
    if (state) {
      this.playerVersion = state.playerVersion; this.queueVersion = state.queueVersion
      if (state.track) this.known.add(state.track.trackKey)
      for (const entry of state.queue) this.known.add(entry.track.trackKey)
    }
  }
  private check(alias: string, args: Record<string, unknown>): void {
    this.scope.assertCurrent()
    if (!(musicAliases as readonly string[]).includes(alias)) throw new Error('MUSIC_TOOL_INVALID')
    if (args.expectedVersion !== undefined && args.expectedVersion !== this.playerVersion) throw new Error('MUSIC_STATE_NOT_OBSERVED')
    if (alias === 'music_queue' && args.queueVersion !== this.queueVersion) throw new Error('MUSIC_STATE_NOT_OBSERVED')
    const keys = [...(args.trackKey ? [args.trackKey as string] : []), ...(args.trackKeys as string[] | undefined ?? [])]
    if (keys.some(key => !this.known.has(key))) throw new Error('MUSIC_TRACK_NOT_OBSERVED')
  }
  local(alias: string, args: Record<string, unknown>): Record<string, unknown> {
    this.check(alias, args); const data = this.music.local(alias, args, this.scope); this.observe(data); return data
  }
  async execute(alias: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.check(alias, args)
    let data: Record<string, unknown>
    if (alias === 'music_search') {
      const keyword = [args.keyword, args.artist, args.instrumental === true ? '纯音乐' : null].filter(Boolean).join(' ')
      const tracks = await this.music.search(keyword, 'all', false, !this.scope.temporary)
      this.scope.assertCurrent(); data = { tracks: tracks.map(musicTrackView), resultId: randomUUID() }
    } else if (['music_get_state', 'music_queue', 'music_favorite', 'music_feedback'].includes(alias)) return this.local(alias, args)
    else data = await this.music.media(alias, args, this.scope)
    this.observe(data); return data
  }
}
