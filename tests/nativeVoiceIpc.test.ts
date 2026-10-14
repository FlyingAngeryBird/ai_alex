import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { R1ModelRequestBoundary } from '../electron/main/r1/modelBoundary'
const state = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, payload?: unknown) => any>(), sessions: [] as any[] }))
vi.mock('electron', () => ({ ipcMain: { handle(name: string, handler: (event: unknown, payload?: unknown) => unknown) { state.handlers.set(name, handler) } } }))
vi.mock('../electron/main/providers/nativeRealtimeSession', () => ({ NativeRealtimeSession: class {
  closed = false
  constructor(public input: any) { state.sessions.push(this) }
  async open() { this.input.boundary.assertCurrent() }
  appendAudio = vi.fn()
  setMuted() {} cancelResponse() {}
  updateBoundary(boundary: R1ModelRequestBoundary) { this.input.boundary = boundary }
  returnToolResult = vi.fn()
  close(code = 'REALTIME_STOPPED') { if (this.closed) return; this.closed = true; this.input.onClosed(code) }
} }))
import { registerNativeVoiceHandlers } from '../electron/main/ipc/nativeVoiceHandlers'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1MemoryStore } from '../electron/main/r1/memory'
import { R1PersonaStore } from '../electron/main/r1/persona'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'

it('destroys the revoked native context and creates a fresh registered boundary without old facts or unheard speech', async () => {
  state.handlers.clear(); state.sessions.length = 0
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db), memory = new R1MemoryStore(db)
  const assets = loadR1PromptAssets(resolve('r1-assets')), tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch())
  const mode = { temporary: false, sessionId: conversations.start() }, sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, send: vi.fn() })
  const controller = registerNativeVoiceHandlers({ db, assets, conversations, memory, tasks, mode,
    persona: new R1PersonaStore(db), configurationRevision: () => 1, implementedTaskAliases: [] })
  const call = (name: string, payload: unknown) => state.handlers.get(name)!({ sender }, payload)
  try {
    conversations.append({ sessionId: mode.sessionId, turnId: 'old', role: 'user', body: '旧事实：计划先做移动版', status: 'final' })
    const saved = memory.addManual({ content: '先做移动版', category: 'ongoing' }), first = randomUUID()
    expect(await call('voice.nativeStart', { connectionId: first })).toMatchObject({ ok: true })
    expect(state.sessions[0].input.boundary.systemText).toContain('计划先做移动版')
    state.sessions[0].input.onEvent({ type: 'response.output_text.done', response_id: 'unheard', text: '尚未播出的旧回复' })
    expect(conversations.modelTurns(mode.sessionId).at(-1)).toMatchObject({ text: '', status: 'interrupted' })
    memory.update({ memoryId: saved.memoryId, expectedVersion: 1, content: '先做中文 macOS 版', category: 'ongoing' })
    expect(() => state.sessions[0].input.boundary.assertCurrent()).toThrow('REALTIME_CONTEXT_INVALIDATED')
    controller.close('MEMORY_CONTEXT_REFRESH_REQUIRED')
    expect(sender.send).toHaveBeenLastCalledWith('voice.nativeEvent', expect.objectContaining({ type: 'closed', code: 'MEMORY_CONTEXT_REFRESH_REQUIRED', connectionId: first }))
    const second = randomUUID()
    expect(await call('voice.nativeStart', { connectionId: second })).toMatchObject({ ok: true })
    const boundary = state.sessions[1].input.boundary as R1ModelRequestBoundary
    expect(boundary.systemText).not.toContain('计划先做移动版'); expect(boundary.systemText).not.toContain('尚未播出的旧回复')
    expect(boundary.systemText).toContain('"deletionEpoch":1'); expect(() => boundary.assertCurrent()).not.toThrow()
    expect(call('voice.nativeAudio', { connectionId: first, pcm: new Uint8Array([0, 0]) })).toMatchObject({ ok: false, error: { code: 'REALTIME_CONNECTION_MISSING' } })
    expect(state.sessions[1].appendAudio).not.toHaveBeenCalled()
    expect(call('voice.nativeAudio', { connectionId: second, pcm: new Uint8Array([0, 0]) })).toMatchObject({ ok: true })
    expect(state.sessions[1].appendAudio).toHaveBeenCalledOnce()
    expect(conversations.messages(mode.sessionId)).toHaveLength(2)
  } finally { controller.close(); tasks.close(); db.close() }
})
