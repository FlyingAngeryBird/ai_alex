import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1TaskToolExecutor } from '../electron/main/r1/taskToolExecutor'
import { R1ConversationTools } from '../electron/main/r1/conversationTools'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { R1Music, musicAliases, type MusicCommand } from '../electron/main/r1/music'
import type { MusicProvider } from '../electron/main/music/gdstudioMusicProvider'

const assets = loadR1PromptAssets(resolve('r1-assets'))
function fixture(temporary = false, confirmed = false, timeoutMs = 500) {
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db)
  const source = conversations.append({ sessionId: conversations.start(temporary), turnId: 'turn', role: 'user', body: '播放测试曲', status: 'final' })
  const tasks = new R1TaskSupervisor(db, assets, () => 0, { temporarySource: id => temporary && id === source.messageId ? { ...source, temporary, timezone: 'Asia/Shanghai' } : undefined })
  const track = { id: 'one', source: 'netease' as const, title: '测试曲', artist: '示例歌手', durationMs: 180000 }
  const idle = { status: 'idle' as const, track: null, positionMs: 0, durationMs: null }
  const provider: MusicProvider = { authorize: async () => ({ authorized: true, provider: 'gdstudio' }), getPlaybackState: async () => idle, pause: async () => idle, resume: async () => idle,
    search: vi.fn(async () => ({ tracks: [track] })), play: vi.fn(async () => ({ ...idle, track: { ...track, audioUrl: 'https://example.org/fixture.mp3' } })) }
  const commands: MusicCommand[] = [], music = new R1Music(db, provider, { timeoutMs }), nonce = music.attach(1, command => commands.push(command))
  let current = true
  const scope = { source, temporary, persistenceConfirmed: confirmed, timezone: 'Asia/Shanghai', assertCurrent() { if (!current) throw new Error('SESSION_CHANGED') } }
  const main = new R1ConversationTools(db, assets, tasks, scope, ['read_file', ...musicAliases], undefined, undefined, music)
  const executor = new R1TaskToolExecutor(tasks, assets, undefined, undefined, undefined, undefined, music)
  return { db, tasks, source, provider, music, commands, main, executor, stale() { current = false },
    ack(command: MusicCommand) { music.report(1, nonce, { commandId: command.commandId, playbackRequestId: command.playbackRequestId,
      status: command.action === 'load' ? 'playing' : 'volume', positionSec: 0, durationSec: 180 }) },
    start() {
      tasks.accept({ requestKey: 'music', sourceMessageId: source.messageId, timezone: 'Asia/Shanghai', goal: source.body,
        constraints: [], authorizedAliases: ['read_file', ...musicAliases], complexity: 'complex', persistenceConfirmed: confirmed })
      const active = tasks.claimNext()!
      executor.execute(active.lease, 'read_file', { file_path: '/skills/music-companion/SKILL.md' }, 'skill')
      return active.lease
    }, close() { music.close(); tasks.close(); db.close() } }
}

it('gates immediate playback on loaded Skill and observed objects, and replays one actual receipt', async () => {
  const s = fixture()
  try {
    await expect(s.main.executeAsync('music_search', { keyword: '测试曲' }, 'before-skill')).rejects.toThrow('MODEL_TOOL_NOT_EXPOSED')
    s.main.execute('load_skill', { skillId: 'SK05' }, 'load')
    expect(await s.main.executeAsync('music_search', { keyword: '测试曲' }, 'search')).toMatchObject({ status: 'succeeded' })
    await s.main.executeAsync('music_get_state', {}, 'state')
    const args = { trackKey: 'netease:one', expectedVersion: 1 }
    const first = s.main.executeAsync('music_play', args, 'play'), duplicate = s.main.executeAsync('music_play', args, 'play')
    await vi.waitFor(() => expect(s.commands.at(-1)?.action).toBe('load')); s.ack(s.commands.at(-1)!)
    const actual = await first
    expect(actual).toMatchObject({ status: 'succeeded', data: { state: { playState: 'playing' } } })
    expect(await duplicate).toEqual(actual); expect(await s.main.executeAsync('music_play', args, 'play')).toEqual(actual)
    expect(s.provider.play).toHaveBeenCalledTimes(1)
    await expect(s.main.executeAsync('music_play', { ...args, expectedVersion: 2 }, 'play')).rejects.toThrow('CONVERSATION_CALL_ID_REUSED')
  } finally { s.close() }
})

it('keeps the actual immediate device receipt after the originating conversation becomes stale', async () => {
  const s = fixture()
  try {
    s.main.execute('load_skill', { skillId: 'SK05' }, 'load')
    await s.main.executeAsync('music_search', { keyword: '测试曲' }, 'search'); await s.main.executeAsync('music_get_state', {}, 'state')
    const pending = s.main.executeAsync('music_play', { trackKey: 'netease:one', expectedVersion: 1 }, 'play')
    const rejected = expect(pending).rejects.toThrow('SESSION_CHANGED')
    await vi.waitFor(() => expect(s.commands.at(-1)?.action).toBe('load'))
    s.stale(); s.ack(s.commands.at(-1)!); await rejected
    expect(s.db.prepare("SELECT status FROM receipts WHERE json_extract(actual_result_json,'$.tool')='music.play'").all()).toEqual([{ status: 'succeeded' }])
  } finally { s.close() }
})
it('drains an interrupted device operation and its durable receipt before database shutdown', async () => {
  const s = fixture()
  try {
    s.main.execute('load_skill', { skillId: 'SK05' }, 'load')
    await s.main.executeAsync('music_search', { keyword: '测试曲' }, 'search'); await s.main.executeAsync('music_get_state', {}, 'state')
    const pending = s.main.executeAsync('music_play', { trackKey: 'netease:one', expectedVersion: 1 }, 'play')
    const rejected = expect(pending).rejects.toThrow('SESSION_CHANGED')
    await vi.waitFor(() => expect(s.commands.at(-1)?.action).toBe('load'))
    s.stale(); s.music.close(); await s.music.whenIdle()
    expect(s.db.prepare("SELECT status FROM receipts WHERE json_extract(actual_result_json,'$.tool')='music.play'").all()).toEqual([{ status: 'cancelled' }])
    await rejected
  } finally { s.close() }
})

it('deduplicates pending task music calls and preserves a completed device action after cancellation', async () => {
  const s = fixture(); let release!: () => void
  try {
    const lease = s.start()
    vi.mocked(s.provider.search).mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve }); return { tracks: [{ id: 'one', source: 'netease', title: '测试曲', artist: '示例歌手', durationMs: 180000 }] } })
    const first = s.executor.executeAsync(lease, 'music_search', { keyword: '测试曲' }, 'search')
    const duplicate = s.executor.executeAsync(lease, 'music_search', { keyword: '测试曲' }, 'search')
    await expect(s.executor.executeAsync(lease, 'music_search', { keyword: '其他曲目' }, 'search')).rejects.toThrow('TASK_TOOL_CALL_ID_REUSED')
    release(); expect(await duplicate).toEqual(await first); expect(s.provider.search).toHaveBeenCalledTimes(1)
    s.executor.execute(lease, 'music_get_state', {}, 'state')
    const pending = s.executor.executeAsync(lease, 'music_play', { trackKey: 'netease:one', expectedVersion: 1 }, 'play')
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(s.commands.at(-1)?.action).toBe('load'))
    s.tasks.cancel(lease.taskId, lease.goalVersion); s.ack(s.commands.at(-1)!); await rejected
    expect(s.tasks.get(lease.taskId).status).toBe('cancelled')
    expect(s.db.prepare("SELECT status FROM receipts WHERE task_id=? AND json_extract(actual_result_json,'$.tool')='music.play'").all(lease.taskId)).toEqual([{ status: 'succeeded' }])
    expect(s.provider.play).toHaveBeenCalledTimes(1)
  } finally { s.close() }
})

it('retains an unknown device receipt and refuses to repeat the same uncertain task action', async () => {
  const s = fixture(false, false, 25)
  try {
    const lease = s.start()
    await s.executor.executeAsync(lease, 'music_search', { keyword: '测试曲' }, 'search')
    s.executor.execute(lease, 'music_get_state', {}, 'state')
    const args = { trackKey: 'netease:one', expectedVersion: 1 }
    const actual = await s.executor.executeAsync(lease, 'music_play', args, 'play')
    expect(actual).toMatchObject({ status: 'unknown', errorCode: 'MUSIC_PLAYBACK_UNKNOWN' })
    await expect(s.executor.executeAsync(lease, 'music_play', args, 'play')).rejects.toThrow('TASK_RECEIPT_RECONCILIATION_REQUIRED')
    expect(s.provider.play).toHaveBeenCalledTimes(1)
  } finally { s.close() }
})

it('requires trusted temporary save confirmation while keeping temporary task bodies and receipts out of SQLite', async () => {
  for (const confirmed of [false, true]) {
    const s = fixture(true, confirmed)
    try {
      const lease = s.start()
      await s.executor.executeAsync(lease, 'music_search', { keyword: '测试曲' }, 'search')
      const actual = s.executor.execute(lease, 'music_favorite', { trackKey: 'netease:one', favorite: true }, 'favorite')
      expect(actual.status).toBe(confirmed ? 'succeeded' : 'failed')
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM music_favorites').get()).toMatchObject({ n: confirmed ? 1 : 0 })
      s.executor.execute(lease, 'music_get_state', {}, 'state')
      const playing = s.executor.executeAsync(lease, 'music_play', { trackKey: 'netease:one', expectedVersion: 1 }, 'play')
      await vi.waitFor(() => expect(s.commands.at(-1)?.action).toBe('load')); s.ack(s.commands.at(-1)!)
      const receipt = await playing
      expect(receipt).toMatchObject({ status: 'succeeded', entityId: 'netease:one' })
      expect(s.tasks.readReceipt(lease, receipt.actionId)).toEqual(receipt)
      expect(await s.executor.executeAsync(lease, 'music_play', { expectedVersion: 1, trackKey: 'netease:one' }, 'play')).toEqual(receipt)
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get()).toMatchObject({ n: 0 })
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()).toMatchObject({ n: 0 })
    } finally { s.close() }
  }
})
