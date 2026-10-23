import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { inTransaction, type R1Database } from '../r1/database.js'
import { musicAliases, type R1Music, type MusicReport } from '../r1/music.js'
import type { R1PromptAssets } from '../r1/promptAssets.js'
import type { R1SessionMode } from '../r1/sessionMode.js'
import { recordMusicDiagnosticFailure } from '../r1/musicDiagnostics.js'

const musicControlPhase = (alias: string | null): string => ({
  music_play: 'play', music_pause: 'pause', music_resume: 'resume', music_next: 'next', music_seek: 'seek',
  music_set_volume: 'volume', music_queue: 'queue', music_favorite: 'favorite', music_feedback: 'feedback'
} as Record<string, string>)[alias ?? ''] ?? 'unknown'

type MusicIpc = { handle(channel: string, handler: (event: { sender: Pick<WebContents, 'id' | 'isDestroyed' | 'send' | 'once'> }, payload?: unknown) => unknown): void }
export function registerR1MusicHandlers(db: R1Database, music: R1Music, assets: R1PromptAssets, mode: R1SessionMode, ipc: MusicIpc = ipcMain) {
  const tracked = (handler: Parameters<MusicIpc['handle']>[1]): Parameters<MusicIpc['handle']>[1] => (event, payload) => music.trackExecution(Promise.resolve(handler(event, payload)))
  const fail = (error: unknown) => { const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'MUSIC_OPERATION_FAILED'; return { ok: false, error: { code, message: code } } }
  ipc.handle('r1.music.attach', ({ sender }) => {
    const nonce = music.attach(sender.id, command => { if (!sender.isDestroyed()) sender.send('r1.musicCommand', command) })
    sender.once('destroyed', () => music.detach(sender.id))
    return { ok: true, data: { nonce, snapshot: music.snapshot() } }
  })
  ipc.handle('r1.music.report', ({ sender }, payload) => {
    try { const input = payload as { nonce: string; report: MusicReport }; music.report(sender.id, input.nonce, input.report); return { ok: true, data: null } }
    catch (error) { return fail(error) }
  })
  ipc.handle('r1.music.detach', ({ sender }) => { music.detach(sender.id); return { ok: true, data: null } })
  ipc.handle('r1.music.artwork', async (_event, payload) => {
    try {
      const trackKey = (payload as { trackKey: string }).trackKey
      if (typeof trackKey !== 'string' || trackKey.length > 1000) throw new Error('MUSIC_TRACK_INVALID')
      return { ok: true, data: await music.artwork(trackKey) }
    } catch (error) { return fail(error) }
  })
  ipc.handle('r1.music.snapshot', () => ({ ok: true, data: music.snapshot() }))
  ipc.handle('r1.music.exit', tracked(async (_event, payload) => {
    const actionId = randomUUID(), started = performance.now(), temporary = mode.temporary
    let mediaConfirmed = false
    const save = (data: Record<string, unknown>, status: string, errorCode: string | null) => {
      if (temporary) return
      const receipt = { kind: 'receipt', actionId, tool: 'music.exit', status, entityId: null,
        entityVersion: (data.state as { playerVersion?: number } | undefined)?.playerVersion ?? null,
        data, errorCode, retryable: false, runId: null }
      assets.validateStructured('tool-output', receipt)
      db.prepare('INSERT INTO receipts(action_id,entity_id,entity_version,status,actual_result_json,created_at) VALUES (?,?,?,?,?,?)')
        .run(actionId, null, receipt.entityVersion, status, JSON.stringify(receipt), new Date().toISOString())
    }
    try {
      const expectedVersion = (payload as { expectedVersion: number }).expectedVersion
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('MUSIC_VERSION_INVALID')
      const data = await music.exit(expectedVersion); mediaConfirmed = true
      save(data, 'succeeded', null)
      return { ok: true, data: { actionId, ...data } }
    } catch (error) {
      if (!mediaConfirmed) try { recordMusicDiagnosticFailure(db, { provider: (music.state().track as { sourceProvider?: string } | null)?.sourceProvider, phase: 'exit', error, durationMs: performance.now() - started }) } catch { /* diagnostics must never change the operation result */ }
      if (mediaConfirmed) return fail(new Error('MUSIC_RECEIPT_PERSIST_FAILED'))
      const result = fail(error)
      try { save({}, result.error.code === 'MUSIC_PLAYBACK_UNKNOWN' ? 'unknown' : 'failed', result.error.code) }
      catch { return fail(new Error('MUSIC_RECEIPT_PERSIST_FAILED')) }
      return result
    }
  }))
  ipc.handle('r1.music.clearHistory', () => {
    try { if (mode.temporary) throw new Error('TEMPORARY_DATA_OPERATION_UNAVAILABLE'); music.clearHistory(); return { ok: true, data: null } } catch (error) { return fail(error) }
  })
  ipc.handle('r1.music.search', async ({ sender }, payload) => {
    const input = payload as { keyword: string; sourcePreference?: 'all' | 'netease' | 'kuwo' | 'joox'; requestId?: string; refresh?: boolean }
    try {
      if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId))) throw new Error('MUSIC_SEARCH_INVALID')
      if (input.refresh !== undefined && typeof input.refresh !== 'boolean') throw new Error('MUSIC_SEARCH_INVALID')
      if (input.sourcePreference !== undefined && !['all', 'netease', 'kuwo', 'joox'].includes(input.sourcePreference)) throw new Error('MUSIC_SEARCH_INVALID')
      assets.validateToolInput('music_search', { keyword: input.keyword })
    } catch (error) { return fail(error) }
    const started = performance.now()
    try { return { ok: true, data: await music.search(input.keyword, input.sourcePreference, !mode.temporary, !mode.temporary, input.requestId ? value => {
      if (!sender.isDestroyed()) sender.send('r1.musicSearchProgress', { requestId: input.requestId, ...value })
    } : undefined, input.refresh === true) } }
    catch (error) {
      try { recordMusicDiagnosticFailure(db, { provider: input.sourcePreference ?? 'all', phase: 'search', error, durationMs: performance.now() - started }) } catch { /* diagnostics must never change the operation result */ }
      return fail(error)
    }
  })
  ipc.handle('r1.music.control', tracked(async (_event, payload) => {
    const actionId = randomUUID(), started = performance.now()
    let alias: string | null = null, temporary = mode.temporary, mediaConfirmed = false
    const save = (data: Record<string, unknown>, status: string, errorCode: string | null) => {
      if (temporary || !alias) return
      const value = { kind: 'receipt', actionId, tool: assets.toolDefinition(alias).name, status,
        entityId: (data.state as { track?: { trackKey?: string } } | undefined)?.track?.trackKey ?? data.feedbackId ?? data.trackKey ?? null,
        entityVersion: (data.state as { playerVersion?: number } | undefined)?.playerVersion ?? null, data, errorCode, retryable: false, runId: null }
      assets.validateToolOutput(alias, value)
      db.prepare('INSERT INTO receipts(action_id,entity_id,entity_version,status,actual_result_json,created_at) VALUES (?,?,?,?,?,?)')
        .run(actionId, value.entityId as string | null, value.entityVersion, status, JSON.stringify(value), new Date().toISOString())
    }
    try {
      const input = payload as { alias: string; args: Record<string, unknown>; temporarySaveConfirmed?: boolean }
      if (!(musicAliases as readonly string[]).includes(input.alias) || input.alias === 'music_search') throw new Error('MUSIC_TOOL_INVALID')
      assets.validateToolInput(input.alias, input.args)
      alias = input.alias
      const scope = { temporary: mode.temporary, persistenceConfirmed: input.temporarySaveConfirmed === true, assertCurrent() {} }
      const local = ['music_get_state', 'music_queue', 'music_favorite', 'music_feedback'].includes(input.alias)
      const data = local ? inTransaction(db, () => { const result = music.local(input.alias, input.args, scope); save(result, 'succeeded', null); return result }) : await music.media(input.alias, input.args, scope)
      if (!local) { mediaConfirmed = true; save(data, 'succeeded', null) }
      return { ok: true, data: { actionId, ...data } }
    } catch (error) {
      if (!mediaConfirmed) try { recordMusicDiagnosticFailure(db, { provider: (music.state().track as { sourceProvider?: string } | null)?.sourceProvider, phase: musicControlPhase(alias), error, durationMs: performance.now() - started }) } catch { /* diagnostics must never change the operation result */ }
      if (mediaConfirmed) return fail(new Error('MUSIC_RECEIPT_PERSIST_FAILED'))
      const result = fail(error)
      try { save({}, result.error.code === 'MUSIC_PLAYBACK_UNKNOWN' ? 'unknown' : 'failed', result.error.code) }
      catch { return fail(new Error('MUSIC_RECEIPT_PERSIST_FAILED')) }
      return result
    }
  }))
  music.onChanged(snapshot => {
    // The single main-window device is also the authoritative source for Focus music binding.
    mode.currentPlayingTrackKey = snapshot.state.playState === 'playing' ? snapshot.state.track?.trackKey ?? null : null
  })
}
