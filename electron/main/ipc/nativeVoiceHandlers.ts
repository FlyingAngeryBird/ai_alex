import { focusToolAliases, type FocusToolServices } from '../r1/focusTools.js'
import { reminderToolAliases } from '../r1/reminderTools.js'
import { selectedConversationEntity } from '../r1/sessionMode.js'
import { ipcMain, type WebContents } from 'electron'
import { NativePlaybackLedger } from '../r1/nativePlayback.js'
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
  implementedTaskAliases: readonly string[]; configurationRevision(): number; focusServices?: FocusToolServices;
}): { close(): void } {
  const sessions = new Map<number, { id: string; session: NativeRealtimeSession; playback(input: Record<string, unknown>): void }>()
  const aliases = ['load_skill', 'start_task', 'get_task', 'steer_task', 'pause_task', 'resume_task', 'cancel_task', 'notes_create', ...reminderToolAliases, ...(deps.focusServices ? focusToolAliases : [])]
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
    const playback = new NativePlaybackLedger(deps.conversations, sessionId)
    const completedInputs = new Set<string>()
    const sourceTurns = new Map<string, string>()
    const context = () => ({ sessionId, sessionGeneration: 1, turnId, currentTime: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, temporary, contextVersion: 1,
      personaVersion: persona.version, deletionEpoch, selectedEntity: selectedConversationEntity(deps.mode, deps.tasks), availableToolAliases: [],
      loadedSkillIds: tools ? [...tools.loadedSkillIds] : ['SK01'],
      recentTurns: deps.conversations.modelTurns(sessionId),
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
        playback.receive(event, typeof event.question_id === 'string' ? sourceTurns.get(event.question_id) ?? turnId : turnId)
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          if (typeof event.item_id !== 'string' || typeof event.transcript !== 'string' || !event.transcript.trim()) return
          if (completedInputs.has(event.item_id)) return
          completedInputs.add(event.item_id); turnId = randomUUID(); toolCount = 0
          sourceTurns.set(event.item_id, turnId)
          const source = deps.conversations.append({ sessionId, turnId, role: 'user', body: event.transcript, status: 'final' })
          tools = new R1ConversationTools(deps.db, deps.assets, deps.tasks, { source, sourceMessages: deps.conversations.messages(sessionId).slice(-20), temporary,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, persistenceConfirmed: false, assertCurrent }, deps.implementedTaskAliases, deps.focusServices)
          connection.updateBoundary(boundary())
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
        try { assertCurrent(); playback.interruptPending() } catch { /* Revoked or ended context cannot publish a late partial. */ }
        if (sessions.get(sender.id)?.id === id) sessions.delete(sender.id)
        sender.removeListener('destroyed', destroyed)
        emit(sender, id, { type: 'closed', code })
      }
    })
    sessions.set(sender.id, { id, session: connection, playback(input) {
      assertCurrent(); playback.playback(input)
    } }); sender.once('destroyed', destroyed)
    try { await connection.open(); return { ok: true, data: { connectionId: id } } }
    catch (error) { connection.close(); return fail(error instanceof Error ? error.message : 'REALTIME_START_FAILED') }
  })
  for (const action of ['Audio', 'Mute', 'Cancel', 'Stop', 'Playback'] as const) {
    ipcMain.handle(`voice.native${action}`, ({ sender }, payload) => {
      const input = payload as { connectionId?: string; pcm?: Uint8Array; muted?: boolean }
      const active = sessions.get(sender.id)
      if (!active || active.id !== input?.connectionId) return fail('REALTIME_CONNECTION_MISSING')
      try {
        if (action === 'Audio') {
          if (!(input.pcm instanceof Uint8Array)) return fail('REALTIME_AUDIO_INVALID')
          active.session.appendAudio(input.pcm)
        } else if (action === 'Playback') active.playback(payload as Record<string, unknown>)
        else if (action === 'Mute') {
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
