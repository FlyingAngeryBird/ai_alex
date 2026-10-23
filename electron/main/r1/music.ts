import { randomUUID } from 'node:crypto'
import { musicText } from '../../shared/musicMatching.js'
import { afterTransactionCommit, afterTransactionRollback, inTransaction, type R1Database } from './database.js'
import type { MusicProvider, MusicTrack, MusicSourcePreference, PlaybackState, MusicSearchProgress } from '../music/gdstudioMusicProvider.js'

export const musicAliases = ['music_search', 'music_get_state', 'music_play', 'music_pause', 'music_resume', 'music_next',
  'music_seek', 'music_set_volume', 'music_queue', 'music_favorite', 'music_feedback'] as const
export type MusicTrackView = { trackKey: string; title: string; artist: string; sourceProvider: string; durationSec: number | null }
export type MusicState = { track: MusicTrackView | null; positionSec: number; playState: 'idle' | 'buffering' | 'playing' | 'paused' | 'failed' | 'ended';
  baseVolume: number; muted: boolean; playerVersion: number; queueVersion: number; queue: Array<{ entryId: string; track: MusicTrackView }> }
export type MusicCommand = { commandId: string; playbackRequestId: string; playerVersion: number;
  action: 'load' | 'pause' | 'resume' | 'seek' | 'volume' | 'stop'; track?: MusicTrack; positionSec: number; volume: number }
export type MusicReport = { commandId: string | null; playbackRequestId: string; status: 'playing' | 'paused' | 'seeked' | 'volume' | 'stopped' | 'failed' | 'ended' | 'progress'; positionSec: number; durationSec: number | null }
export type MusicScope = { temporary: boolean; persistenceConfirmed: boolean; sourceRef?: string; assertCurrent(): void }
export type MusicSnapshot = { state: MusicState; playback: PlaybackState; favorites: MusicTrack[]; searchHistory: string[];
  queue: Array<{ entryId: string; track: MusicTrack }>; resourceAttempts: number; failureReasons: string[] }
const key = (track: MusicTrack) => `${track.source}:${track.id}`
const normal = (value: string) => musicText(value).replace(/\s+/g, '')
const sameRecording = (left: MusicTrack, right: MusicTrack) => normal(left.title) === normal(right.title) && normal(left.artist) === normal(right.artist) &&
  !['', '未知歌手'].includes(left.artist) && (!left.durationMs || !right.durationMs || Math.abs(left.durationMs - right.durationMs) <= 3000)
const trackView = (track: MusicTrack): MusicTrackView => ({ trackKey: key(track), title: track.title, artist: track.artist,
  sourceProvider: track.source!, durationSec: track.durationMs > 0 ? track.durationMs / 1000 : null })
const metadata = (track: MusicTrack): MusicTrack => {
  if (!track || !['netease', 'kuwo', 'joox'].includes(track.source!) || !track.id || [...key(track)].length > 160 ||
    !track.title || [...track.title].length > 300 || !track.artist || [...track.artist].length > 300) throw new Error('MUSIC_TRACK_INVALID')
  const { audioUrl: _audio, lyrics: _lyrics, ...value } = track
  return structuredClone({ ...value, durationMs: Number.isFinite(value.durationMs) && value.durationMs > 0 ? value.durationMs : 0 })
}

/** Owns versions and durable music objects; only the attached audio device can confirm playback. */
export class R1Music {
  private readonly tracks = new Map<string, MusicTrack>()
  private queue: Array<{ entryId: string; track: MusicTrack }> = []
  private current: MusicTrack | null = null
  private position = 0; private playState: MusicState['playState'] = 'idle'
  private volume = 100; private playerVersion = 1; private queueVersion = 0; private mediaGeneration = 0
  private playbackRequestId = randomUUID(); private attempts = 0; private failures: string[] = []
  private owner: { id: number; nonce: string; send(command: MusicCommand): void } | null = null
  private pending = new Map<string, { command: MusicCommand; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private readonly listeners = new Set<(snapshot: MusicSnapshot) => void>()
  private closed = false
  private readonly operations = new Set<Promise<unknown>>()
  private favoriteCache: MusicTrack[] | null = null
  private historyCache: string[] | null = null
  constructor(private readonly db: R1Database, private readonly provider: MusicProvider, private readonly options: {
    timeoutMs?: number; resourceAttempts?: number; legacy?: { favorites: MusicTrack[]; searchHistory: string[] }
  } = {}) {
    const settings = db.prepare('SELECT base_volume, queue_version FROM music_settings WHERE id=1').get() as { base_volume: number; queue_version: number }
    this.volume = settings.base_volume; this.queueVersion = settings.queue_version
    if (options.legacy && !db.prepare('SELECT 1 FROM legacy_import WHERE source=?').get('r1-music-json')) {
      inTransaction(db, () => {
        for (const track of options.legacy!.favorites) { try { const safe = metadata(track); db.prepare('INSERT OR IGNORE INTO music_favorites VALUES (?,?,?)').run(key(safe), JSON.stringify(safe), new Date().toISOString()) } catch { /* Keep unsupported legacy records in the unchanged source file. */ } }
        for (const query of options.legacy!.searchHistory.slice().reverse()) this.rememberSearch(query)
        db.prepare('INSERT INTO legacy_import(source,snapshot_json,imported_at) VALUES (?,?,?)').run('r1-music-json', '{}', new Date().toISOString())
      })
    }
    for (const track of this.favorites()) { try { this.tracks.set(key(track), metadata(track)) } catch { /* Invalid legacy metadata is not executable. */ } }
    this.queue = (db.prepare('SELECT entry_id,track_json FROM music_queue ORDER BY position').all() as { entry_id: string; track_json: string }[])
      .map(row => ({ entryId: row.entry_id, track: metadata(JSON.parse(row.track_json)) }))
    for (const entry of this.queue) this.tracks.set(key(entry.track), entry.track)
    const receipts = db.prepare(`SELECT actual_result_json FROM receipts WHERE status='succeeded'
      AND json_extract(actual_result_json,'$.tool') LIKE 'music.%' ORDER BY created_at DESC,rowid DESC LIMIT 100`).all() as { actual_result_json: string }[]
    for (const row of receipts.reverse()) {
      try {
        const data = JSON.parse(row.actual_result_json).data as { state?: { track?: MusicTrackView }; tracks?: MusicTrackView[] }
        for (const view of [...(data.tracks ?? []), ...(data.state?.track ? [data.state.track] : [])]) {
          const split = view.trackKey.indexOf(':'), source = view.trackKey.slice(0, split)
          if (source !== view.sourceProvider) continue
          this.register({ id: view.trackKey.slice(split + 1), source: source as MusicTrack['source'], title: view.title, artist: view.artist, durationMs: (view.durationSec ?? 0) * 1000 })
        }
      } catch { /* Unsupported legacy receipts remain stored without granting an identity. */ }
    }
  }
  onChanged(listener: (snapshot: MusicSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { afterTransactionCommit(this.db, () => { for (const listener of this.listeners) { try { listener(this.snapshot()) } catch { /* Observation cannot change a committed state. */ } } }) }
  private favorites(): MusicTrack[] {
    if (this.favoriteCache) return structuredClone(this.favoriteCache)
    this.favoriteCache = (this.db.prepare('SELECT track_json FROM music_favorites ORDER BY created_at').all() as { track_json: string }[]).flatMap(row => {
      try { return [metadata(JSON.parse(row.track_json))] } catch { return [] }
    })
    return structuredClone(this.favoriteCache)
  }
  snapshot(): MusicSnapshot {
    return { state: this.state(), playback: { status: this.playState === 'buffering' ? 'loading' : this.playState === 'failed' ? 'error' : this.playState === 'ended' ? 'paused' : this.playState,
      track: this.current ? structuredClone(this.current) : null, positionMs: Math.round(this.position * 1000), durationMs: this.current?.durationMs || null,
      ...(this.playState === 'failed' ? { errorMessage: '当前音乐资源未能完成播放，请重试或选择其他音源。' } : {}) },
      favorites: this.favorites(), searchHistory: [...(this.historyCache ??= (this.db.prepare('SELECT query FROM music_search_history ORDER BY searched_at DESC, rowid DESC LIMIT 8').all() as { query: string }[]).map(row => row.query))],
      queue: structuredClone(this.queue), resourceAttempts: this.attempts, failureReasons: [...this.failures] }
  }
  state(): MusicState { return { track: this.current ? trackView(this.current) : null, positionSec: this.position, playState: this.playState,
    baseVolume: this.volume, muted: this.volume === 0, playerVersion: this.playerVersion, queueVersion: this.queueVersion,
    queue: this.queue.map(entry => ({ entryId: entry.entryId, track: trackView(entry.track) })) } }
  stateData(): Record<string, unknown> { return { state: this.state(), resourceAttempts: this.attempts, failureReasons: [...this.failures] } }
  preferences(): Array<{ feedbackId: string; track: MusicTrackView | null; feedback: 'like' | 'dislike' | 'skip'; scene: string | null }> {
    return (this.db.prepare('SELECT feedback_id,track_key,kind,scene FROM music_feedback ORDER BY created_at DESC,rowid DESC LIMIT 20').all() as { feedback_id: string; track_key: string; kind: 'like' | 'dislike' | 'skip'; scene: string | null }[])
      .map(row => ({ feedbackId: row.feedback_id, track: this.tracks.has(row.track_key) ? trackView(this.tracks.get(row.track_key)!) : null, feedback: row.kind, scene: row.scene }))
  }
  attach(ownerId: number, send: (command: MusicCommand) => void): string {
    if (this.closed) throw new Error('MUSIC_SERVICE_CLOSED')
    if (this.owner?.id === ownerId) return this.owner.nonce
    if (this.owner) this.detach(this.owner.id)
    this.owner = { id: ownerId, nonce: randomUUID(), send }; return this.owner.nonce
  }
  detach(ownerId: number): void {
    if (this.owner?.id !== ownerId) return
    this.sendStop(); this.cancelPending(true); this.owner = null; this.playerVersion++; this.mediaGeneration++; this.playbackRequestId = randomUUID()
    this.playState = this.current ? 'paused' : 'idle'; this.emit()
  }
  private cancelPending(includeVolume = false): void {
    for (const [id, pending] of this.pending) if (includeVolume || pending.command.action !== 'volume') { clearTimeout(pending.timer); pending.reject(new Error('MUSIC_SUPERSEDED')); this.pending.delete(id) }
  }
  private device(): NonNullable<R1Music['owner']> { if (!this.owner || this.closed) throw new Error('MUSIC_DEVICE_UNAVAILABLE'); return this.owner }
  private async command(action: MusicCommand['action'], version: number, track?: MusicTrack, position = this.position, volume = this.volume): Promise<void> {
    const owner = this.device()
    if (version !== this.playerVersion) throw new Error('MUSIC_SUPERSEDED')
    const command: MusicCommand = { commandId: randomUUID(), playbackRequestId: this.playbackRequestId, playerVersion: version, action, track,
      positionSec: position, volume }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(command.commandId)) return
        this.pending.delete(command.commandId)
        if (['load', 'resume'].includes(action) && command.playbackRequestId === this.playbackRequestId) { this.playState = 'failed'; this.emit(); this.sendStop() }
        reject(new Error('MUSIC_PLAYBACK_UNKNOWN'))
      }, this.options.timeoutMs ?? 10000)
      this.pending.set(command.commandId, { command, resolve, reject, timer })
      try { owner.send(command) } catch { clearTimeout(timer); this.pending.delete(command.commandId); reject(new Error('MUSIC_DEVICE_UNAVAILABLE')) }
    })
  }
  private sendStop(): void {
    try { this.owner?.send({ action: 'stop', commandId: randomUUID(), playbackRequestId: this.playbackRequestId,
      playerVersion: this.playerVersion, positionSec: this.position, volume: this.volume }) } catch { /* Device state remains unconfirmed. */ }
  }
  report(ownerId: number, nonce: string, input: MusicReport): void {
    const pending = input.commandId ? this.pending.get(input.commandId) : undefined
    if (this.owner?.id !== ownerId || this.owner.nonce !== nonce || input.playbackRequestId !== this.playbackRequestId && pending?.command.action !== 'volume') throw new Error('MUSIC_STALE_DEVICE_REPORT')
    if (!Number.isFinite(input.positionSec) || input.positionSec < 0 || input.positionSec > 86400 ||
      input.durationSec !== null && (!Number.isFinite(input.durationSec) || input.durationSec < 0 || input.durationSec > 86400)) throw new Error('MUSIC_REPORT_INVALID')
    if (pending) {
      const expected = { load: 'playing', resume: 'playing', pause: 'paused', seek: 'seeked', volume: 'volume', stop: 'stopped' }[pending.command.action]
      if (![expected, 'failed'].includes(input.status)) throw new Error('MUSIC_REPORT_INVALID')
      clearTimeout(pending.timer); this.pending.delete(pending.command.commandId)
      if (pending.command.action !== 'volume') {
        this.position = input.positionSec
        if (input.durationSec !== null && this.current) this.current.durationMs = Math.round(input.durationSec * 1000)
      }
      if (input.status === 'failed') { if (pending.command.action !== 'volume') this.playState = 'failed'; pending.reject(new Error('MUSIC_DEVICE_PLAY_FAILED')) }
      else {
        if (input.status === 'playing') this.playState = 'playing'
        if (input.status === 'paused') this.playState = 'paused'
        if (input.status === 'stopped') this.playState = 'ended'
        pending.resolve()
      }
      this.emit(); return
    }
    if (!['progress', 'ended', 'failed'].includes(input.status)) return
    this.position = input.positionSec
    if (input.durationSec !== null && this.current) this.current.durationMs = Math.round(input.durationSec * 1000)
    if (input.status === 'progress') return
    if (input.status === 'failed') { this.playState = 'failed'; this.playerVersion++ }
    if (input.status === 'ended') {
      this.playState = 'ended'; this.playerVersion++
      const version = this.playerVersion
      if (this.queue.length) void this.media('music_next', { expectedVersion: version }, { temporary: false, persistenceConfirmed: true, assertCurrent() {} }).catch(() => undefined)
    }
    this.emit()
  }
  register(track: MusicTrack): MusicTrack {
    const safe = metadata(track), existing = this.tracks.get(key(safe))
    if (!safe.artworkUrl && existing?.artworkUrl) safe.artworkUrl = existing.artworkUrl
    this.tracks.set(key(safe), safe); return safe
  }
  async artwork(trackKey: string): Promise<string | null> {
    const track = this.track(trackKey)
    const url = track.artworkUrl ?? await this.provider.artwork?.(track)
    if (url && !this.closed) this.register({ ...track, artworkUrl: url })
    return url ?? null
  }
  track(trackKey: string): MusicTrack { const track = this.tracks.get(trackKey); if (!track) throw new Error('MUSIC_TRACK_NOT_AVAILABLE'); return structuredClone(track) }
  private trackOperation<T>(promise: Promise<T>): Promise<T> {
    const tracked = promise.finally(() => { this.operations.delete(tracked) }); this.operations.add(tracked); return tracked
  }
  /** Include receipt persistence in shutdown draining, beyond the device command itself. */
  trackExecution<T>(promise: Promise<T>): Promise<T> { return this.trackOperation(promise) }
  async whenIdle(): Promise<void> { while (this.operations.size) await Promise.allSettled([...this.operations]) }
  search(keyword: string, sourcePreference: MusicSourcePreference = 'all', remember = false, useFeedback = true, onProgress?: (value: MusicSearchProgress) => void, refresh = false): Promise<MusicTrack[]> {
    return this.trackOperation(this.searchImpl(keyword, sourcePreference, remember, useFeedback, onProgress, refresh))
  }
  private async searchImpl(keyword: string, sourcePreference: MusicSourcePreference, remember: boolean, useFeedback: boolean, onProgress?: (value: MusicSearchProgress) => void, refresh = false): Promise<MusicTrack[]> {
    if (this.closed || typeof keyword !== 'string' || !keyword.trim() || [...keyword].length > 800) throw new Error('MUSIC_SEARCH_INVALID')
    const result = await this.provider.search({ query: keyword.trim(), sourcePreference, ...(refresh ? { refresh: true } : {}) }, onProgress ? value => {
      if (this.closed) return
      // Partial rows must already be registered before the UI can play or queue them.
      const tracks = value.tracks.slice(0, 50).flatMap(track => { try { return [this.register(track)] } catch { return [] } })
      onProgress({ ...value, tracks })
    } : undefined)
    if (this.closed) throw new Error('MUSIC_SERVICE_CLOSED')
    const tracks = result.tracks.slice(0, 50).flatMap(track => { try { return [this.register(track)] } catch { return [] } })
    const latest = useFeedback ? this.db.prepare(`SELECT track_key,kind FROM (SELECT track_key,kind,ROW_NUMBER() OVER(PARTITION BY track_key ORDER BY created_at DESC,rowid DESC) AS rank
      FROM music_feedback WHERE kind IN ('like','dislike')) WHERE rank=1`).all() as { track_key: string; kind: string }[] : []
    const disliked = new Set(latest.filter(row => row.kind === 'dislike').map(row => row.track_key))
    if (!tracks.some(track => [normal(track.title), normal(`${track.title} ${track.artist}`)].includes(normal(keyword))))
      tracks.sort((left, right) => Number(disliked.has(key(left))) - Number(disliked.has(key(right))))
    if (remember) { this.rememberSearch(keyword.trim()); this.emit() }
    return tracks
  }
  private rememberSearch(query: string): void {
    if (!query.trim() || [...query].length > 300) return
    this.db.prepare('INSERT INTO music_search_history VALUES (?,?) ON CONFLICT(query) DO UPDATE SET searched_at=excluded.searched_at').run(query, new Date().toISOString())
    this.db.exec('DELETE FROM music_search_history WHERE query NOT IN (SELECT query FROM music_search_history ORDER BY searched_at DESC,rowid DESC LIMIT 8)')
    this.historyCache = null
  }
  clearHistory(): void { this.db.exec('DELETE FROM music_search_history'); this.historyCache = null; this.emit() }
  private persistQueue(): void {
    inTransaction(this.db, () => {
      this.db.exec('DELETE FROM music_queue')
      for (const [position, entry] of this.queue.entries()) this.db.prepare('INSERT INTO music_queue VALUES (?,?,?,?,?)')
        .run(entry.entryId, position, key(entry.track), JSON.stringify(metadata(entry.track)), this.queueVersion)
      this.db.prepare('UPDATE music_settings SET queue_version=?,updated_at=? WHERE id=1').run(this.queueVersion, new Date().toISOString())
    })
  }
  local(alias: string, args: Record<string, unknown>, scope: MusicScope): Record<string, unknown> {
    scope.assertCurrent()
    if (alias === 'music_get_state') return { ...this.stateData(), feedback: scope.temporary ? [] : this.preferences() }
    if (scope.temporary && !scope.persistenceConfirmed) throw new Error('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
    if (alias === 'music_queue') {
      if (args.queueVersion !== this.queueVersion) throw new Error('VERSION_CONFLICT')
      const trackKeys = args.trackKeys as string[], entryIds = args.entryIds as string[], ordered = args.orderedEntryIds as string[]
      let next = structuredClone(this.queue)
      if (args.action === 'add') next.push(...trackKeys.map(id => ({ entryId: randomUUID(), track: this.track(id) })))
      else if (args.action === 'remove') { if (entryIds.some(id => !next.some(entry => entry.entryId === id))) throw new Error('MUSIC_QUEUE_ENTRY_NOT_FOUND'); next = next.filter(entry => !entryIds.includes(entry.entryId)) }
      else if (args.action === 'reorder') {
        if (new Set(ordered).size !== next.length || ordered.length !== next.length || ordered.some(id => !next.some(entry => entry.entryId === id))) throw new Error('MUSIC_QUEUE_ORDER_INVALID')
        next = ordered.map(id => next.find(entry => entry.entryId === id)!)
      } else if (args.action === 'clear') next = []
      else throw new Error('MUSIC_QUEUE_ACTION_INVALID')
      if (next.length > 50) throw new Error('MUSIC_QUEUE_LIMIT')
      const previous = this.queue, version = this.queueVersion
      afterTransactionRollback(this.db, () => { this.queue = previous; this.queueVersion = version })
      try { this.queue = next; this.queueVersion++; this.persistQueue() } catch (error) { this.queue = previous; this.queueVersion = version; throw error }
      this.emit(); return this.stateData()
    }
    const track = this.track(args.trackKey as string)
    if (alias === 'music_favorite') {
      if (args.favorite) this.db.prepare('INSERT INTO music_favorites VALUES (?,?,?) ON CONFLICT(track_key) DO UPDATE SET track_json=excluded.track_json').run(key(track), JSON.stringify(metadata(track)), new Date().toISOString())
      else this.db.prepare('DELETE FROM music_favorites WHERE track_key=?').run(key(track))
      afterTransactionCommit(this.db, () => { this.favoriteCache = null })
      this.emit(); return { trackKey: key(track), favorite: args.favorite }
    }
    if (alias !== 'music_feedback' || !['like', 'dislike', 'skip'].includes(String(args.feedback))) throw new Error('MUSIC_TOOL_INVALID')
    const feedbackId = randomUUID()
    this.db.prepare('INSERT INTO music_feedback(feedback_id,track_key,kind,created_at,scene,source_ref) VALUES (?,?,?,?,?,?)')
      .run(feedbackId, key(track), args.feedback as string, new Date().toISOString(), args.scene as string | null ?? null, scope.temporary ? null : scope.sourceRef ?? null)
    this.emit(); return { feedbackId, trackKey: key(track), feedback: args.feedback, scene: args.scene ?? null }
  }
  media(alias: string, args: Record<string, unknown>, scope: MusicScope): Promise<Record<string, unknown>> { return this.trackOperation(this.mediaImpl(alias, args, scope)) }
  /** Explicit UI exit releases the player, while the durable queue remains a separate object. */
  exit(expectedVersion: number): Promise<Record<string, unknown>> {
    return this.trackOperation(this.exitImpl(expectedVersion))
  }
  private async exitImpl(expectedVersion: number): Promise<Record<string, unknown>> {
    this.device()
    if (expectedVersion !== this.playerVersion) throw new Error('VERSION_CONFLICT')
    this.cancelPending(); const generation = ++this.mediaGeneration, version = ++this.playerVersion
    await this.command('stop', version)
    if (generation !== this.mediaGeneration) throw new Error('MUSIC_SUPERSEDED')
    this.current = null; this.position = 0; this.playState = 'idle'; this.emit()
    return this.stateData()
  }
  private async mediaImpl(alias: string, args: Record<string, unknown>, scope: MusicScope): Promise<Record<string, unknown>> {
    scope.assertCurrent(); this.device()
    if (args.expectedVersion !== this.playerVersion) throw new Error('VERSION_CONFLICT')
    if (alias === 'music_play') return this.play(this.track(args.trackKey as string), scope)
    if (alias === 'music_next') {
      const next = this.queue[0]
      if (next) {
        scope.assertCurrent(); const previous = this.queue, previousVersion = this.queueVersion
        try { this.queue = this.queue.slice(1); this.queueVersion++; this.persistQueue() }
        catch (error) { this.queue = previous; this.queueVersion = previousVersion; throw error }
        this.emit()
        return this.play(next.track, scope)
      }
    }
    if (alias === 'music_resume' && this.current && (!this.current.audioUrl || this.playState === 'failed')) return this.play(this.current, scope)
    if (['music_resume', 'music_seek'].includes(alias) && !this.current) throw new Error('MUSIC_NO_CURRENT_TRACK')
    if (alias === 'music_seek' && (args.trackKey !== key(this.current!) || (args.positionSec as number) > (this.current!.durationMs || 86400000) / 1000)) throw new Error('MUSIC_SEEK_OUT_OF_RANGE')
    if (alias === 'music_seek' && this.playState === 'buffering') throw new Error('MUSIC_NOT_READY')
    if (alias === 'music_set_volume') {
      const version = ++this.playerVersion; this.volume = args.volume as number
      this.db.prepare('UPDATE music_settings SET base_volume=?,updated_at=? WHERE id=1').run(this.volume, new Date().toISOString()); this.emit()
      await this.command('volume', version); return this.stateData()
    }
    this.cancelPending(); this.mediaGeneration++; const version = ++this.playerVersion
    const action = ({ music_pause: 'pause', music_resume: 'resume', music_next: 'stop', music_seek: 'seek', music_set_volume: 'volume' } as Record<string, MusicCommand['action']>)[alias]
    if (!action) throw new Error('MUSIC_TOOL_INVALID')
    await this.command(action, version, alias === 'music_resume' ? this.current ?? undefined : undefined, alias === 'music_seek' ? args.positionSec as number : this.position,
      alias === 'music_set_volume' ? args.volume as number : this.volume)
    if (alias === 'music_set_volume') this.db.prepare('UPDATE music_settings SET base_volume=?,updated_at=? WHERE id=1').run(this.volume, new Date().toISOString())
    return this.stateData()
  }
  private async play(selected: MusicTrack, scope: MusicScope): Promise<Record<string, unknown>> {
    const generation = this.mediaGeneration + 1
    try { return await this.playImpl(selected, scope) }
    catch (error) { if (this.mediaGeneration === generation && this.playState === 'buffering') { this.playState = 'failed'; this.sendStop(); this.emit() }; throw error }
  }
  private async playImpl(selected: MusicTrack, scope: MusicScope): Promise<Record<string, unknown>> {
    this.cancelPending(); ++this.playerVersion; const generation = ++this.mediaGeneration
    this.playbackRequestId = randomUUID(); this.current = selected; this.position = 0; this.playState = 'buffering'
    this.attempts = 0; this.failures = []; this.sendStop(); this.emit()
    const tried = new Set<string>(); let candidates = [selected]
    const maximum = Math.min(3, this.options.resourceAttempts ?? 3)
    while (this.attempts < maximum) {
      scope.assertCurrent()
      if (generation !== this.mediaGeneration) throw new Error('MUSIC_SUPERSEDED')
      const candidate = candidates.find(track => !tried.has(key(track)))
      if (!candidate) break
      tried.add(key(candidate)); this.attempts++
      try {
        const resolved = await this.provider.play({ trackId: candidate.id, source: candidate.source, playbackId: candidate.playbackId,
          title: candidate.title, artist: candidate.artist, album: candidate.album, durationMs: candidate.durationMs, artworkId: candidate.artworkId, lyricId: candidate.lyricId })
        scope.assertCurrent()
        if (generation !== this.mediaGeneration) throw new Error('MUSIC_SUPERSEDED')
        const track = resolved.track
        if (!track?.audioUrl || key(track) !== key(candidate) || normal(candidate.title) !== normal(track.title) || normal(candidate.artist) !== normal(track.artist)) throw new Error('MUSIC_RESOURCE_UNAVAILABLE')
        const url = new URL(track.audioUrl)
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('MUSIC_RESOURCE_URL_INVALID')
        this.current = { ...metadata(track), audioUrl: track.audioUrl, lyrics: track.lyrics }
        this.playbackRequestId = randomUUID(); this.playState = 'buffering'; this.emit()
        await this.command('load', this.playerVersion, this.current, 0)
        return this.stateData()
      } catch (error) {
        if (generation !== this.mediaGeneration) throw new Error('MUSIC_SUPERSEDED')
        const code = error instanceof Error ? error.message : 'MUSIC_RESOURCE_FAILED'
        if (code === 'MUSIC_PLAYBACK_UNKNOWN') throw error
        this.failures.push(/^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'MUSIC_RESOURCE_FAILED')
        if (candidates.length === 1 && this.attempts < maximum) {
          const alternatives = await this.search(`${selected.title} ${selected.artist}`, 'all', false, !scope.temporary)
          scope.assertCurrent()
          candidates = [selected, ...alternatives.filter(track => sameRecording(selected, track) && key(track) !== key(selected))]
        }
      }
    }
    if (generation === this.mediaGeneration) { this.playState = 'failed'; this.sendStop(); this.emit() }
    throw new Error('MUSIC_RESOURCES_EXHAUSTED')
  }
  close(): void { if (this.owner) this.detach(this.owner.id); for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('MUSIC_SERVICE_CLOSED')) }; this.pending.clear(); this.closed = true; this.provider.close?.(); this.listeners.clear() }
}

export { key as musicTrackKey, trackView as musicTrackView }
