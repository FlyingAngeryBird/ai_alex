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
