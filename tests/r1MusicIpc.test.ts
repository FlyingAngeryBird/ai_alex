import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { registerR1MusicHandlers } from '../electron/main/ipc/musicR1Handlers'
import { R1Music, type MusicCommand } from '../electron/main/r1/music'
import type { R1SessionMode } from '../electron/main/r1/sessionMode'
const assets = loadR1PromptAssets(resolve('r1-assets'))
function fixture(rejectOutput = false) {
  const db = openR1Database(':memory:'), track = { source: 'netease' as const, id: 'ipc-one', title: '合成曲', artist: '合成歌手', durationMs: 90000 }
  const idle = { status: 'idle' as const, track: null, positionMs: 0, durationMs: null }
  const music = new R1Music(db, { authorize: async () => ({ authorized: true, provider: 'gdstudio' }), pause: async () => idle, resume: async () => idle, getPlaybackState: async () => idle,
    search: async () => ({ tracks: [track] }), play: async () => ({ ...idle, track: { ...track, audioUrl: 'https://example.org/fixture.mp3' } }) }, { timeoutMs: 100 })
  const mode: R1SessionMode = { temporary: false }, handlers = new Map<string, (event: { sender: typeof sender }, payload?: unknown) => unknown>()
  let nonce = ''
  const sender = { id: 1, isDestroyed: () => false, once: vi.fn(), send(_event: string, command: MusicCommand) {
    queueMicrotask(() => { try { music.report(1, nonce, { commandId: command.commandId, playbackRequestId: command.playbackRequestId,
      status: command.action === 'load' ? 'playing' : command.action === 'stop' ? 'stopped' : 'volume', positionSec: 0, durationSec: 90 }) } catch { /* Unconfirmed stop events are discarded. */ } })
  } }
  const configured = rejectOutput ? { ...assets, validateToolOutput(alias: string, value: unknown) {
    if ((value as { status: string }).status === 'succeeded') throw new Error('MODEL_TOOL_OUTPUT_DATA_INVALID')
    assets.validateToolOutput(alias, value)
  } } : assets
  registerR1MusicHandlers(db, music, configured, mode, { handle(channel, handler) { handlers.set(channel, handler as (event: { sender: typeof sender }, payload?: unknown) => unknown) } })
  const invoke = async (channel: string, payload?: unknown) => await handlers.get(`r1.music.${channel}`)!({ sender }, payload) as { ok: boolean; data: Record<string, unknown>; error?: { code: string } }
  const attached = handlers.get('r1.music.attach')!({ sender }) as { data: { nonce: string } }; nonce = attached.data.nonce
  return { db, music, mode, invoke, close() { music.close(); db.close() } }
}
it('routes GUI actions through device acknowledgement and actual receipts, with temporary receipts kept off disk', async () => {
  const s = fixture()
  try {
    expect((await s.invoke('search', { keyword: '合成曲' })).ok).toBe(true)
    const played = await s.invoke('control', { alias: 'music_play', args: { trackKey: 'netease:ipc-one', expectedVersion: 1 } })
    expect(played.ok).toBe(true)
    expect(JSON.parse((s.db.prepare('SELECT actual_result_json FROM receipts WHERE action_id=?').get(played.data.actionId as string) as { actual_result_json: string }).actual_result_json))
      .toMatchObject({ tool: 'music.play', status: 'succeeded', data: { state: { playState: 'playing' } } })
    const exited = await s.invoke('exit', { expectedVersion: s.music.state().playerVersion })
    expect(exited.ok).toBe(true); expect(s.music.state().track).toBeNull()
    expect(s.db.prepare("SELECT status FROM receipts WHERE json_extract(actual_result_json,'$.tool')='music.exit'").all()).toEqual([{ status: 'succeeded' }])
    s.mode.temporary = true
    expect(await s.invoke('control', { alias: 'music_favorite', args: { trackKey: 'netease:ipc-one', favorite: true } })).toMatchObject({ ok: false, error: { code: 'TEMPORARY_SAVE_CONFIRMATION_REQUIRED' } })
    expect((await s.invoke('control', { alias: 'music_favorite', args: { trackKey: 'netease:ipc-one', favorite: true }, temporarySaveConfirmed: true })).ok).toBe(true)
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()).toMatchObject({ n: 2 })
    expect(s.music.snapshot().favorites).toHaveLength(1)
  } finally { s.close() }
})
it('rolls back GUI queue changes if the canonical output cannot be validated', async () => {
  const s = fixture(true)
  try {
    await s.invoke('search', { keyword: '合成曲' })
    const failed = await s.invoke('control', { alias: 'music_queue', args: { action: 'add', queueVersion: 0, trackKeys: ['netease:ipc-one'], entryIds: [], orderedEntryIds: [] } })
    expect(failed).toMatchObject({ ok: false, error: { code: 'MODEL_TOOL_OUTPUT_DATA_INVALID' } })
    expect(s.music.state()).toMatchObject({ queue: [], queueVersion: 0 })
    expect(s.db.prepare('SELECT * FROM music_queue').all()).toEqual([])
    expect(s.db.prepare('SELECT status FROM receipts').all()).toEqual([{ status: 'failed' }])
  } finally { s.close() }
})
