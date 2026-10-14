import { ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { NativeRealtimeSession, type NativeRealtimeEvent } from '../providers/nativeRealtimeSession.js'
import { R1ModelRequestBoundary } from '../r1/modelBoundary.js'
import { R1ConversationTools } from '../r1/conversationTools.js'
import type { R1Database } from '../r1/database.js'
import type { R1PromptAssets } from '../r1/promptAssets.js'
import type { R1PersonaStore } from '../r1/persona.js'
import type { R1MemoryStore } from '../r1/memory.js'
import type { R1Conversations } from '../r1/conversations.js'
import type { R1TaskSupervisor } from '../r1/taskSupervisor.js'
import type { R1SessionMode } from '../r1/sessionMode.js'

export function registerNativeVoiceHandlers(deps: {
  db: R1Database; assets: R1PromptAssets; persona: R1PersonaStore; memory: R1MemoryStore;
  conversations: R1Conversations; tasks: R1TaskSupervisor; mode: R1SessionMode;
  implementedTaskAliases: readonly string[]; configurationRevision(): number;
}): { close(): void } {
  const sessions = new Map<number, { id: string; session: NativeRealtimeSession }>()
  const aliases = ['load_skill', 'start_task', 'get_task', 'steer_task', 'pause_task', 'resume_task', 'cancel_task', 'notes_create']
  const fail = (code: string) => ({ ok: false, error: { code, message: code } })
  const emit = (owner: WebContents, id: string, event: NativeRealtimeEvent) => {
    if (!owner.isDestroyed()) owner.send('voice.nativeEvent', { ...event, connectionId: id })
  }
  ipcMain.handle('voice.nativeStart', async ({ sender }, payload) => {
    if (sessions.has(sender.id)) return fail('REALTIME_ALREADY_STARTED')
    const id = (payload as { connectionId?: unknown })?.connectionId
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id)) return fail('REALTIME_INPUT_INVALID')
    const sessionId = deps.mode.sessionId
    if (!sessionId) return fail('REALTIME_SESSION_MISSING')
    const persona = deps.persona.get(), deletionEpoch = deps.memory.currentDeletionEpoch()
    const revision = deps.configurationRevision(), temporary = deps.mode.temporary
    const assertCurrent = () => {
      if (deps.mode.sessionId !== sessionId || deps.mode.temporary !== temporary ||
        deps.persona.get().version !== persona.version || deps.memory.currentDeletionEpoch() !== deletionEpoch ||
        deps.configurationRevision() !== revision) throw new Error('REALTIME_CONTEXT_INVALIDATED')
    }
    let tools: R1ConversationTools | null = null
    let turnId = randomUUID(), toolCount = 0
    const completedInputs = new Set<string>(), savedResponses = new Set<string>()
    const context = () => ({ sessionId, sessionGeneration: 1, turnId, currentTime: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, temporary, contextVersion: 1,
      personaVersion: persona.version, deletionEpoch, selectedEntity: null, availableToolAliases: [],
      loadedSkillIds: tools ? [...tools.loadedSkillIds] : ['SK01'],
      recentTurns: deps.conversations.messages(sessionId).slice(-24).map(message => ({
        turnId: message.turnId, role: message.role, text: message.body, heardText: null,
        status: message.status === 'interrupted' ? 'interrupted' : 'valid' })),
      memories: [], activeTasks: deps.tasks.list(temporary ? sessionId : null).slice(-20).map(task => {
        const { taskId, goalVersion, status, goal } = deps.tasks.modelView(task.taskId)
        return { taskId, goalVersion, status, goal }
      }) })
    const boundary = () => new R1ModelRequestBoundary(deps.assets, persona, context(), aliases, 'realtime', assertCurrent, toolCount >= 6)
    const destroyed = () => connection.close()
    const connection = new NativeRealtimeSession({ apiKey: process.env.VOLCENGINE_REALTIME_API_KEY ?? '',
      voice: persona.voiceId || process.env.VOLCENGINE_REALTIME_VOICE || '', boundary: boundary(),
      onEvent(event) {
        assertCurrent()
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          if (typeof event.item_id !== 'string' || typeof event.transcript !== 'string' || !event.transcript.trim()) return
          if (completedInputs.has(event.item_id)) return
          completedInputs.add(event.item_id); turnId = randomUUID(); toolCount = 0
          const source = deps.conversations.append({ sessionId, turnId, role: 'user', body: event.transcript, status: 'final' })
          tools = new R1ConversationTools(deps.db, deps.assets, deps.tasks, { source, temporary,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, persistenceConfirmed: false, assertCurrent }, deps.implementedTaskAliases)
          connection.updateBoundary(boundary())
        }
        if (event.type === 'response.output_text.done' && typeof event.response_id === 'string' &&
          typeof event.text === 'string' && event.text.trim() && !savedResponses.has(event.response_id)) {
          deps.conversations.append({ sessionId, turnId, responseId: event.response_id, role: 'assistant',
            body: event.text, status: 'generated' }); savedResponses.add(event.response_id)
        }
        emit(sender, id, event)
      },
      onToolCalls(calls) {
        assertCurrent()
        if (!tools || toolCount + calls.length > 6) { connection.close('REALTIME_TOOL_SOURCE_OR_BUDGET_INVALID'); return }
        const results = calls.map(call => {
          const result = tools!.execute(call.name, call.arguments, call.callId)
          toolCount++
          return { callId: call.callId, result }
        })
        connection.updateBoundary(boundary())
        for (const result of results) connection.returnToolResult(result.callId, result.result)
      },
      onClosed(code) {
        if (sessions.get(sender.id)?.id === id) sessions.delete(sender.id)
        sender.removeListener('destroyed', destroyed)
        emit(sender, id, { type: 'closed', code })
      }
    })
    sessions.set(sender.id, { id, session: connection }); sender.once('destroyed', destroyed)
    try { await connection.open(); return { ok: true, data: { connectionId: id } } }
    catch (error) { connection.close(); return fail(error instanceof Error ? error.message : 'REALTIME_START_FAILED') }
  })
  for (const action of ['Audio', 'Mute', 'Cancel', 'Stop'] as const) {
    ipcMain.handle(`voice.native${action}`, ({ sender }, payload) => {
      const input = payload as { connectionId?: string; pcm?: Uint8Array; muted?: boolean }
      const active = sessions.get(sender.id)
      if (!active || active.id !== input?.connectionId) return fail('REALTIME_CONNECTION_MISSING')
      try {
        if (action === 'Audio') {
          if (!(input.pcm instanceof Uint8Array)) return fail('REALTIME_AUDIO_INVALID')
          active.session.appendAudio(input.pcm)
        } else if (action === 'Mute') {
          if (typeof input.muted !== 'boolean') return fail('REALTIME_INPUT_INVALID')
          active.session.setMuted(input.muted)
        } else if (action === 'Cancel') active.session.cancelResponse()
        else active.session.close()
        return { ok: true, data: null }
      } catch { active.session.close('REALTIME_COMMAND_FAILED'); return fail('REALTIME_COMMAND_FAILED') }
    })
  }
  return { close() { for (const active of [...sessions.values()]) active.session.close() } }
}
