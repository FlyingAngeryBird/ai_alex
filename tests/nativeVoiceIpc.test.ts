import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
const state = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload?: unknown) => unknown>() }))
vi.mock('electron', () => ({ ipcMain: { handle(name: string, handler: (event: unknown, payload?: unknown) => unknown) { state.handlers.set(name, handler) } } }))
import { registerNativeVoiceHandlers } from '../electron/main/ipc/nativeVoiceHandlers'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1MemoryStore } from '../electron/main/r1/memory'
import { R1PersonaStore } from '../electron/main/r1/persona'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'

afterEach(() => vi.unstubAllEnvs())
class Socket extends EventEmitter {
  bufferedAmount = 0
  sent: Record<string, unknown>[] = []
  terminate = vi.fn()
  send(value: string) {
    const event = JSON.parse(value); this.sent.push(event)
    if (event.type === 'session.create') this.event({ type: 'session.created', session: { id: randomUUID() } })
  }
  event(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false) }
  instructions(): string { return (this.sent.find(event => event.type === 'session.create')!.session as { instructions: string }).instructions }
}

it('destroys the revoked native context and creates a fresh registered boundary without old facts or unheard speech', async () => {
  state.handlers.clear()
  vi.stubEnv('VOLCENGINE_REALTIME_API_KEY', 'synthetic'); vi.stubEnv('VOLCENGINE_REALTIME_VOICE', 'synthetic_voice')
  const sockets: Socket[] = []
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db), memory = new R1MemoryStore(db)
  const assets = loadR1PromptAssets(resolve('r1-assets')), tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch())
  const mode = { temporary: false, sessionId: conversations.start() }, sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: vi.fn() })
  const controller = registerNativeVoiceHandlers({ db, assets, conversations, memory, tasks, mode,
    persona: new R1PersonaStore(db), configurationRevision: () => 1, implementedTaskAliases: [], connect() {
      const socket = new Socket(); sockets.push(socket); queueMicrotask(() => socket.emit('open'))
      return socket as unknown as WebSocket
    } })
  const call = (name: string, payload: unknown) => state.handlers.get(name)!({ sender }, payload)
  try {
    conversations.append({ sessionId: mode.sessionId, turnId: 'old', role: 'user', body: '旧事实：计划先做移动版', status: 'final' })
    const saved = memory.addManual({ content: '先做移动版', category: 'ongoing' }), first = randomUUID()
    expect(await call('voice.nativeStart', { connectionId: first })).toMatchObject({ ok: true })
    expect(sockets[0].instructions()).toContain('计划先做移动版')
    sockets[0].event({ type: 'response.output_text.done', response_id: 'unheard', text: '尚未播出的旧回复' })
    expect(conversations.modelTurns(mode.sessionId).at(-1)).toMatchObject({ text: '', status: 'interrupted' })
    memory.update({ memoryId: saved.memoryId, expectedVersion: 1, content: '先做中文 macOS 版', category: 'ongoing' })
    controller.close('MEMORY_CONTEXT_REFRESH_REQUIRED')
    expect(sockets[0].terminate).toHaveBeenCalledOnce()
    expect(sender.send).toHaveBeenLastCalledWith('voice.nativeEvent', expect.objectContaining({ type: 'closed', code: 'MEMORY_CONTEXT_REFRESH_REQUIRED', connectionId: first }))
    const second = randomUUID()
    expect(await call('voice.nativeStart', { connectionId: second })).toMatchObject({ ok: true })
    const instructions = sockets[1].instructions()
    expect(instructions).not.toContain('计划先做移动版'); expect(instructions).not.toContain('尚未播出的旧回复')
    expect(instructions).toContain('"deletionEpoch":1')
    expect(call('voice.nativeAudio', { connectionId: first, pcm: new Uint8Array([0, 0]) })).toMatchObject({ ok: false, error: { code: 'REALTIME_CONNECTION_MISSING' } })
    expect(sockets[1].sent.some(event => event.type === 'input_audio_buffer.append')).toBe(false)
    expect(call('voice.nativeAudio', { connectionId: second, pcm: new Uint8Array([0, 0]) })).toMatchObject({ ok: true })
    expect(sockets[1].sent.filter(event => event.type === 'input_audio_buffer.append')).toHaveLength(1)
    sender.send.mockClear()
    sockets[0].event({ type: 'response.output_text.done', response_id: 'late', text: '迟到旧事实' })
    expect(sender.send).not.toHaveBeenCalled()
    expect(conversations.messages(mode.sessionId)).toHaveLength(2)
  } finally { controller.close(); tasks.close(); db.close() }
})

it('routes native search tool results back to the same call IDs, emits bounded evidence and discards interrupted work', async () => {
  state.handlers.clear()
  vi.stubEnv('VOLCENGINE_REALTIME_API_KEY', 'synthetic'); vi.stubEnv('VOLCENGINE_REALTIME_VOICE', 'synthetic_voice')
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db), memory = new R1MemoryStore(db)
  const assets = loadR1PromptAssets(resolve('r1-assets')), tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch())
  const mode = { temporary: false, sessionId: conversations.start() }, sender = Object.assign(new EventEmitter(), { id: 2, isDestroyed: () => false, send: vi.fn() })
  const socket = new Socket()
  let finish!: (value: unknown) => void
  const search = vi.fn(async () => new Promise<any>(resolve => { finish = resolve }))
  const controller = registerNativeVoiceHandlers({ db, assets, conversations, memory, tasks, mode,
    persona: new R1PersonaStore(db), configurationRevision: () => 1, implementedTaskAliases: ['read_file', 'web_search', 'web_read_page'],
    search: { search }, pages: { read: vi.fn() }, connect() { queueMicrotask(() => socket.emit('open')); return socket as unknown as WebSocket } })
  const tool = (call_id: string, name: string, args: unknown) => socket.event({ type: 'response.function_call_arguments.done', items: [{ call_id, name, arguments: JSON.stringify(args) }] })
  try {
    expect(await state.handlers.get('voice.nativeStart')!({ sender }, { connectionId: randomUUID() })).toMatchObject({ ok: true })
    socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q1', transcript: '查一下天气' })
    tool('load', 'load_skill', { skillId: 'SK02' })
    await vi.waitFor(() => expect(socket.sent.filter(e => e.type === 'conversation.item.create')).toHaveLength(1))
    tool('search1', 'web_search', { query: 'Shanghai weather 2026-10-17' })
    expect(search).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('voice.nativeEvent', expect.objectContaining({ type: 'search.state', phase: 'searching' }))
    finish({ query: 'weather', queriedAtUtc: '2026-10-17T05:00:00Z', candidates: [], moreResultsAvailable: false })
    await vi.waitFor(() => expect(socket.sent.filter(e => e.type === 'conversation.item.create')).toHaveLength(2))
    const returned = socket.sent.filter(e => e.type === 'conversation.item.create').at(-1) as { items: Array<{ call_id: string; content: Array<{ text: string }> }> }
    expect(returned.items[0].call_id).toBe('search1')
    expect(returned.items[0]).toMatchObject({ type: 'message', role: 'tool' })
    expect(JSON.parse(returned.items[0].content[0].text)).toMatchObject({ tool: 'web.search', status: 'succeeded' })
    socket.event({ type: 'response.output_text.done', response_id: 'answer1', text: '未查到天气信息' })
    expect(sender.send).toHaveBeenCalledWith('voice.nativeEvent', expect.objectContaining({ type: 'search.state', phase: 'ready' }))
    socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q2', transcript: '再查一下' })
    tool('load2', 'load_skill', { skillId: 'SK02' })
    await vi.waitFor(() => expect(socket.sent.filter(e => e.type === 'conversation.item.create')).toHaveLength(3))
    tool('search2', 'web_search', { query: 'new query' })
    expect(search).toHaveBeenCalledTimes(2)
    socket.event({ type: 'conversation.item.input_audio_transcription.started', item_id: 'q3' })
    socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q3', transcript: '别查了，聊别的' })
    finish({ query: 'stale', queriedAtUtc: '2026-10-17T05:00:00Z', candidates: [], moreResultsAvailable: false })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(socket.sent.filter(e => e.type === 'conversation.item.create')).toHaveLength(3)
    expect(socket.terminate).not.toHaveBeenCalled()
    expect(tasks.list()).toHaveLength(0)
    const stored = db.prepare("SELECT actual_result_json FROM receipts WHERE actual_result_json LIKE '%web.search%'").all()
    expect(stored).toHaveLength(1)
    socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q4', transcript: '重新查一下天气' })
    tool('load4', 'load_skill', { skillId: 'SK02' })
    await vi.waitFor(() => expect(socket.sent.filter(e => e.type === 'conversation.item.create')).toHaveLength(4))
    tool('search4', 'web_search', { query: 'weather' })
    expect(search).toHaveBeenCalledTimes(3)
    socket.event({ type: 'conversation.item.input_audio_transcription.started', item_id: 'q5' })
    socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q5', transcript: '先别说。' })
    finish({ query: 'weather', queriedAtUtc: '2026-10-17T05:00:00Z', candidates: [], moreResultsAvailable: false })
    await vi.waitFor(() => expect(db.prepare("SELECT actual_result_json FROM receipts WHERE actual_result_json LIKE '%web.search%'").all()).toHaveLength(2))
    // Stop-speech retains the read receipt but never returns it for old speech.
    expect(socket.sent.filter(e => e.type === 'conversation.item.create')).toHaveLength(4)
    expect(socket.terminate).not.toHaveBeenCalled()
  } finally { controller.close(); tasks.close(); db.close() }
})

it('plays a cached hint locally after 1.5 seconds without injecting TTS into the pending FC connection', async () => {
  vi.useFakeTimers(); state.handlers.clear()
  vi.stubEnv('VOLCENGINE_REALTIME_API_KEY', 'synthetic'); vi.stubEnv('VOLCENGINE_REALTIME_VOICE', 'synthetic_voice')
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db), memory = new R1MemoryStore(db)
  const assets = loadR1PromptAssets(resolve('r1-assets')), tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch())
  const mode = { temporary: false, sessionId: conversations.start() }, sender = Object.assign(new EventEmitter(), { id: 3, isDestroyed: () => false, send: vi.fn() })
  const socket = new Socket(); let finish!: (value: any) => void
  const controller = registerNativeVoiceHandlers({ db, assets, conversations, memory, tasks, mode,
    persona: new R1PersonaStore(db), configurationRevision: () => 1, implementedTaskAliases: [],
    search: { search: () => new Promise(resolve => { finish = resolve }) }, pages: { read: vi.fn() },
    searchHint: async () => Buffer.from([1, 0, 2, 0]),
    connect() { queueMicrotask(() => socket.emit('open')); return socket as unknown as WebSocket } })
  const tool = (id: string, name: string, args: unknown) => socket.event({ type: 'response.function_call_arguments.done', items: [{ call_id: id, name, arguments: JSON.stringify(args) }] })
  try {
    await state.handlers.get('voice.nativeStart')!({ sender }, { connectionId: randomUUID() })
    await vi.advanceTimersByTimeAsync(0)
    socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q', transcript: '查询天气' })
    tool('load', 'load_skill', { skillId: 'SK02' }); await vi.advanceTimersByTimeAsync(0)
    tool('query', 'web_search', { query: 'weather' }); await vi.advanceTimersByTimeAsync(1500)
    expect(sender.send).toHaveBeenCalledWith('voice.nativeEvent', expect.objectContaining({ type: 'response.output_audio.delta', response_id: expect.stringMatching(/^search-hint:/) }))
    expect(socket.sent.some(e => e.type === 'speech_text_buffer.commit')).toBe(false)
    finish({ query: 'weather', queriedAtUtc: '2026-10-17T05:00:00Z', candidates: [], moreResultsAvailable: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(socket.sent.filter(e => e.type === 'conversation.item.create')).toHaveLength(2)
    socket.event({ type: 'response.output_text.done', response_id: 'final', text: '未查到可靠信息' })
    expect(sender.send).toHaveBeenCalledWith('voice.nativeEvent', expect.objectContaining({ type: 'search.state', phase: 'ready' }))
    expect(socket.terminate).not.toHaveBeenCalled()
  } finally { controller.close(); tasks.close(); db.close(); vi.useRealTimers() }
})
