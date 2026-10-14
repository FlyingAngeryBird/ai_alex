import { focusToolAliases, type FocusToolServices } from '../r1/focusTools.js'
import { reminderToolAliases } from '../r1/reminderTools.js'
import { memoryToolAliases, memoryMutationReply } from '../r1/memoryTools.js'
import type { R1MemoryConfirmations } from '../r1/memoryConfirmations.js'
import type { R1AutomaticMemory } from '../r1/automaticMemory.js'
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
  onMemoryInvalidated?(deletionEpoch: number): void;
  memoryConfirmations?: R1MemoryConfirmations;
  automaticMemory?: R1AutomaticMemory;
}): { close(): void } {
  const sessions = new Map<number, { id: string; session: NativeRealtimeSession; playback(input: Record<string, unknown>): void }>()
  const aliases = ['load_skill', 'start_task', 'get_task', 'steer_task', 'pause_task', 'resume_task', 'cancel_task', ...memoryToolAliases, 'notes_create', ...reminderToolAliases, ...(deps.focusServices ? focusToolAliases : [])]
  const fail = (code: string) => ({ ok: false, error: { code, message: code } })
  const emit = (owner: WebContents, id: string, event: NativeRealtimeEvent) => {
    if (!owner.isDestroyed()) owner.send('voice.nativeEvent', { ...event, connectionId: id })
  }
  ipcMain.handle('voice.nativeStart', async ({ sender }, payload) => {
    if (sessions.has(sender.id)) return fail('REALTIME_ALREADY_STARTED')
    const id = (payload as { connectionId?: unknown })?.connectionId
    if (typeof id !== 'string' || !/^[\da-f-]{36}$/i.test(id)) return fail('REALTIME_INPUT_INVALID')
    const activeSessionId = deps.mode.sessionId
    if (!activeSessionId) return fail('REALTIME_SESSION_MISSING')
    const sessionId: string = activeSessionId
    const persona = deps.persona.get(), deletionEpoch = deps.memory.currentDeletionEpoch()
    const revision = deps.configurationRevision(), temporary = deps.mode.temporary
    const assertCurrent = () => {
      if (deps.mode.sessionId !== sessionId || deps.mode.temporary !== temporary ||
        deps.persona.get().version !== persona.version || deps.memory.currentDeletionEpoch() !== deletionEpoch ||
        deps.configurationRevision() !== revision) throw new Error('REALTIME_CONTEXT_INVALIDATED')
    }
    let tools: R1ConversationTools | null = null
    let invalidatedEpoch: number | null = null
    let turnId = randomUUID(), toolCount = 0
    const playback = new NativePlaybackLedger(deps.conversations, sessionId)
    const completedInputs = new Set<string>()
    const sourceTurns = new Map<string, string>()
    const automaticSourceTurns = new Map<string, string>()
    function extractMemory(responseId: unknown): void {
      if (temporary || !deps.automaticMemory || !deps.memoryConfirmations || typeof responseId !== 'string') return
      const boundTurnId = automaticSourceTurns.get(responseId)
      if (!boundTurnId) return
      const messages = deps.conversations.messages(sessionId)
      const reply = messages.find(message => message.responseId === responseId && message.role === 'assistant' && message.turnId === boundTurnId)
      const source = reply && messages.find(message => message.turnId === reply.turnId && message.role === 'user')
      if (!source || deps.memoryConfirmations.hasPendingForSource(source.messageId)) return
      deps.automaticMemory.enqueue({ source, temporary: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        assertSession() { if (deps.mode.sessionId !== sessionId || deps.mode.temporary) throw new Error('AUTO_MEMORY_SESSION_REVOKED') },
        assertLatest() { assertCurrent(); if (turnId !== source.turnId) throw new Error('AUTO_MEMORY_SOURCE_REVOKED') },
        confirmSensitive() {
          const version = deps.automaticMemory!.getPolicy().version
          deps.memoryConfirmations!.offerSelection({ source, ownerId: sender.id, temporary: false, sensitive: true, automatic: true,
            assertCurrent() { assertCurrent(); deps.automaticMemory!.assertAuthorized(version); if (turnId !== source.turnId) throw new Error('AUTO_MEMORY_SOURCE_REVOKED') } })
        } })
    }
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
        const actualSourceTurn = typeof event.question_id === 'string' ? sourceTurns.get(event.question_id) : undefined
        if (actualSourceTurn && typeof event.response_id === 'string') automaticSourceTurns.set(event.response_id, actualSourceTurn)
        playback.receive(event, typeof event.question_id === 'string' ? sourceTurns.get(event.question_id) ?? turnId : turnId)
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          if (typeof event.item_id !== 'string' || typeof event.transcript !== 'string' || !event.transcript.trim()) return
          if (completedInputs.has(event.item_id)) return
          completedInputs.add(event.item_id); turnId = randomUUID(); toolCount = 0
          deps.memoryConfirmations?.revoke(sender.id)
          sourceTurns.set(event.item_id, turnId)
          const source = deps.conversations.append({ sessionId, turnId, role: 'user', body: event.transcript, status: 'final' })
          const sourceTurnId = turnId
          tools = new R1ConversationTools(deps.db, deps.assets, deps.tasks, { source, sourceMessages: deps.conversations.messages(sessionId).slice(-20), temporary,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, persistenceConfirmed: false, assertCurrent,
            onMemoryInvalidated: deps.onMemoryInvalidated ? epoch => { invalidatedEpoch = epoch } : undefined,
            requestMemoryConfirmation: deps.memoryConfirmations ? (candidate, sensitive) => deps.memoryConfirmations!.offer(candidate, {
              ownerId: sender.id, source, temporary, sensitive, assertCurrent() {
                assertCurrent(); if (turnId !== sourceTurnId) throw new Error('MEMORY_CONFIRMATION_STALE')
              }
            }) : undefined }, deps.implementedTaskAliases, deps.focusServices)
          connection.updateBoundary(boundary())
        }
        emit(sender, id, event)
        if (event.type === 'response.done') extractMemory(event.response_id)
      },
      onToolCalls(calls) {
        assertCurrent()
        if (!tools || toolCount + calls.length > 6) { connection.close('REALTIME_TOOL_SOURCE_OR_BUDGET_INVALID'); return }
        const results = []
        for (const call of calls) {
          const result = tools!.execute(call.name, call.arguments, call.callId)
          toolCount++
          results.push({ callId: call.callId, result })
          if (tools!.memoryMutationReceipt) {
            // Do not ask a cloud session containing revoked facts to generate the acknowledgement.
            const reply = memoryMutationReply(result), responseId = randomUUID()
            deps.conversations.append({ sessionId, turnId, responseId, role: 'assistant', body: reply, status: 'generated' })
            emit(sender, id, { type: 'response.output_text.done', response_id: responseId, text: reply })
            connection.close('MEMORY_CONTEXT_REFRESH_REQUIRED')
            deps.onMemoryInvalidated!(invalidatedEpoch!)
            return
          }
        }
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
      if (input.status === 'completed') extractMemory(input.responseId)
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
