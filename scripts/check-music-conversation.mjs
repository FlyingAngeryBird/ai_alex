// Actual Ark decisions with synthetic track metadata and an explicitly simulated audio device.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1PersonaStore } from '../dist-electron/main/r1/persona.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1ConversationDriver } from '../dist-electron/main/r1/conversationDriver.js'
import { R1Music, musicAliases } from '../dist-electron/main/r1/music.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
const endpoint = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'ark.cn-beijing.volces.com') throw new Error('OFFICIAL_ENDPOINT_REQUIRED')
const db = openR1Database(':memory:'), assets = loadR1PromptAssets(resolve('r1-assets')), conversations = new R1Conversations(db), persona = new R1PersonaStore(db)
const candidate = { id: 'synthetic-1', source: 'netease', title: '清晨的风', artist: '示例乐队', durationMs: 180000 }
const initial = { status: 'idle', track: null, positionMs: 0, durationMs: null }
const music = new R1Music(db, { search: async () => ({ tracks: [candidate] }), play: async () => ({ ...initial, track: { ...candidate, audioUrl: 'https://example.org/synthetic.mp3' } }),
  authorize: async () => ({ authorized: true, provider: 'gdstudio' }), getPlaybackState: async () => initial, pause: async () => initial, resume: async () => initial })
let nonce; const commands = []
nonce = music.attach(1, command => { commands.push(command.action); queueMicrotask(() => { try {
  music.report(1, nonce, { commandId: command.commandId, playbackRequestId: command.playbackRequestId,
    status: { load: 'playing', pause: 'paused', resume: 'playing', seek: 'seeked', volume: 'volume', stop: 'stopped' }[command.action], positionSec: command.positionSec, durationSec: 180 })
} catch { /* Old device events are intentionally rejected. */ } }) })
const tasks = new R1TaskSupervisor(db, assets, () => 0), requests = []
const provider = createArkResponsesProvider({ timeoutMs: 30000, fetch: async (url, init) => {
  const response = await fetch(url, init), body = await response.clone().json()
  const calls = (body.output ?? []).filter(item => item.type === 'function_call')
  requests.push(calls.map(item => item.name))
  if (process.env.SEAMO_CHECK_DIAGNOSTIC === '1') console.log(JSON.stringify({ syntheticCalls: calls.map(item => ({ name: item.name, arguments: JSON.parse(item.arguments) })) }))
  return response
} })
const driver = new R1ConversationDriver(db, assets, tasks, provider, () => persona.get(), ['read_file', 'write_todos', ...musicAliases], undefined, undefined, music)
try {
  const sessionId = conversations.start()
  for (const [phase, text] of [['play', '请播放示例乐队的《清晨的风》。'], ['volume', '把音乐音量调到30%。'], ['mention', '我只是提到歌曲，不用再播放了，我们聊聊今天的计划。']]) {
    const source = conversations.append({ sessionId, turnId: randomUUID(), role: 'user', body: text, status: 'final' }), start = performance.now(), before = commands.length
    const result = await driver.reply({ scope: { source, temporary: false, timezone: 'Asia/Shanghai', persistenceConfirmed: false, assertCurrent() {} },
      messages: [{ role: 'user', content: text }], context: { sessionId, turnId: source.turnId, sessionGeneration: 1, currentTime: source.createdAt, timezone: 'Asia/Shanghai', temporary: false,
        contextVersion: 1, personaVersion: persona.get().version, deletionEpoch: 0, selectedEntity: null, availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: [], memories: [], topics: [], activeTasks: [] } })
    const state = music.state(), passed = phase === 'play' ? state.playState === 'playing' && state.track?.title === candidate.title :
      phase === 'volume' ? state.baseVolume === 30 : commands.length === before
    console.log(JSON.stringify({ phase, status: passed ? 'passed' : 'failed', reply: result.reply, state,
      device: 'simulated', model: 'real_ark', productionDataUsed: false, elapsedMs: Math.round(performance.now() - start) }))
    if (!passed) throw new Error('MUSIC_SEMANTIC_CASE_FAILED')
  }
  console.log(JSON.stringify({ status: 'passed', requests, receiptCount: db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n, assetReleaseId: assets.releaseId }))
} catch (error) { console.log(JSON.stringify({ status: 'failed', code: error.code ?? error.message, requests, currentState: music.state() })); process.exitCode = 1 }
finally { tasks.close(); music.close(); await music.whenIdle(); db.close() }
