import { focusToolAliases, type FocusToolServices } from '../r1/focusTools.js'
import { reminderToolAliases } from '../r1/reminderTools.js'
import { memoryToolAliases, memoryMutationReply } from '../r1/memoryTools.js'
import type { R1MemoryConfirmations } from '../r1/memoryConfirmations.js'
import { topicConversationContext } from '../r1/topicContext.js'
import { currentArtifactContext } from '../r1/artifactContext.js'
import { R1Artifacts } from '../r1/artifacts.js'
import { musicAliases, type R1Music } from '../r1/music.js'
import type { R1TopicSummaries } from '../r1/topicSummaries.js'
import type { R1AutomaticMemory } from '../r1/automaticMemory.js'
import { selectedConversationEntity, currentCandidateContext } from '../r1/sessionMode.js'
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
import { RealtimeSearchTurn } from '../r1/realtimeSearch.js'
import type { SearchProvider } from '../providers/searchProvider.js'
import type { createPageReader } from '../providers/pageReader.js'
import type { createNativeSearchHintCache } from '../providers/nativeSearchHint.js'

export function registerNativeVoiceHandlers(deps: {
  db: R1Database; assets: R1PromptAssets; persona: R1PersonaStore; memory: R1MemoryStore;
  conversations: R1Conversations; tasks: R1TaskSupervisor; mode: R1SessionMode;
  implementedTaskAliases: readonly string[]; configurationRevision(): number; focusServices?: FocusToolServices;
  onMemoryInvalidated?(deletionEpoch: number): void;
  memoryConfirmations?: R1MemoryConfirmations;
  topicSummaries?: R1TopicSummaries
  automaticMemory?: R1AutomaticMemory;
  connect?: ConstructorParameters<typeof NativeRealtimeSession>[0]['connect'];
  artifacts?: R1Artifacts;
  music?: R1Music;
  search?: SearchProvider;
  pages?: ReturnType<typeof createPageReader>;
  searchHint?: ReturnType<typeof createNativeSearchHintCache>;
}): { close(code?: string): void } {
  const sessions = new Map<number, { id: string; session: NativeRealtimeSession; silenceSearch(): void; playback(input: Record<string, unknown>): void }>()
  const aliases = ['load_skill', 'start_task', 'get_task', 'steer_task', 'pause_task', 'resume_task', 'cancel_task', ...memoryToolAliases, 'notes_create', ...reminderToolAliases, ...(deps.focusServices ? focusToolAliases : []), ...(deps.music ? musicAliases : []), ...(deps.search && deps.pages ? ['web_search', 'web_read_page'] : [])]
  const taskAliases = deps.implementedTaskAliases.filter(alias => !['web_search', 'web_read_page'].includes(alias))
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
    // Read the released Skill before constructing the native boundary. Keeping
    // this small read-only Skill resident avoids an extra FC round and a tool
    // set update in the middle of a time-sensitive search.
    const nativeSkills = ['SK01', ...(deps.search && deps.pages ? [deps.assets.loadSkill('SK02').skillId] : [])]
    const persona = deps.persona.get(), deletionEpoch = deps.memory.currentDeletionEpoch()
    const revision = deps.configurationRevision(), temporary = deps.mode.temporary
    const artifacts = deps.artifacts ?? new R1Artifacts(deps.db)
    const selectedArtifact = currentArtifactContext(deps.mode, artifacts), selectionKey = JSON.stringify(deps.mode.selectedArtifact ?? null)
    const selectedCandidate = currentCandidateContext(deps.mode, deps.tasks)
    const candidateKey = JSON.stringify([deps.mode.selectedCandidate ?? null, selectedCandidate])
    const topicKey = JSON.stringify(deps.mode.selectedTopic ?? null)
    const assertCurrent = () => {
      if (deps.mode.sessionId !== sessionId || deps.mode.temporary !== temporary ||
        deps.persona.get().version !== persona.version || deps.memory.currentDeletionEpoch() !== deletionEpoch ||
        deps.configurationRevision() !== revision || JSON.stringify(deps.mode.selectedArtifact ?? null) !== selectionKey ||
        JSON.stringify(deps.mode.selectedTopic ?? null) !== topicKey ||
        JSON.stringify([deps.mode.selectedCandidate ?? null, currentCandidateContext(deps.mode, deps.tasks)]) !== candidateKey ||
        JSON.stringify(currentArtifactContext(deps.mode, artifacts)) !== JSON.stringify(selectedArtifact)) throw new Error('REALTIME_CONTEXT_INVALIDATED')
    }
    let tools: R1ConversationTools | null = null
    let invalidatedEpoch: number | null = null
    let turnId = randomUUID(), toolCount = 0
    let searchTurn: RealtimeSearchTurn | null = null
    let searchOwner: { revoked: boolean; silent: boolean } | null = null
    const retainedSearches = new Set<RealtimeSearchTurn>()
    let visibleSilentOwner: { revoked: boolean; silent: boolean } | null = null
    let hintAudio: Buffer | null = null
    const hintAbort = new AbortController()
    let inputGeneration = 0
    let responseSeen = false, userSpeaking = false, hintActive = false
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
      deps.topicSummaries?.enqueue({ source, temporary: false, requireHeardAssistant: true, assertSession() { if (deps.mode.sessionId !== sessionId || deps.mode.temporary) throw new Error('SUMMARY_CONTEXT_REVOKED') } })
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
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, temporary, contextVersion: 1, realtimeSimpleSearch: true,
      personaVersion: persona.version, deletionEpoch, selectedEntity: selectedArtifact ? { type: 'artifact', id: selectedArtifact.artifactId, version: selectedArtifact.version } : topicConversationContext(deps.db, deps.mode).selected ?? selectedConversationEntity(deps.mode, deps.tasks), currentArtifact: selectedArtifact, availableToolAliases: [],
      currentCandidate: selectedCandidate, loadedSkillIds: tools ? [...tools.loadedSkillIds] : nativeSkills,
      recentTurns: deps.conversations.modelTurns(sessionId),
      memories: [], topics: topicConversationContext(deps.db, deps.mode).topics, activeTasks: deps.tasks.list(temporary ? sessionId : null).slice(-20).map(task => {
        const { taskId, goalVersion, status, goal } = deps.tasks.modelView(task.taskId)
        return { taskId, goalVersion, status, goal }
      }) })
    const boundary = () => new R1ModelRequestBoundary(deps.assets, persona, context(), aliases, 'realtime', assertCurrent, toolCount >= 6, taskAliases)
    const destroyed = () => connection.close()
    const connection = new NativeRealtimeSession({ apiKey: process.env.VOLCENGINE_REALTIME_API_KEY ?? '',
      voice: persona.voiceId || process.env.VOLCENGINE_REALTIME_VOICE || '', boundary: boundary(),
      connect: deps.connect,
      onEvent(event) {
        assertCurrent()
        if (event.type === 'conversation.item.input_audio_transcription.started') {
          userSpeaking = true
          // Stop delivery immediately, but wait for the final transcript before
          // deciding whether this is the explicit stop-speech control.
          inputGeneration++; visibleSilentOwner = null
        }
        if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done' || event.type === 'response.output_audio.delta') {
          responseSeen = true; if (!hintActive) searchTurn?.answerStarted()
        }
        if (event.type === 'response.output_audio.done') hintActive = false
        const actualSourceTurn = typeof event.question_id === 'string' ? sourceTurns.get(event.question_id) : undefined
        if (actualSourceTurn && typeof event.response_id === 'string') automaticSourceTurns.set(event.response_id, actualSourceTurn)
        playback.receive(event, typeof event.question_id === 'string' ? sourceTurns.get(event.question_id) ?? turnId : turnId)
        if (event.type === 'conversation.item.input_audio_transcription.completed') {
          if (typeof event.item_id !== 'string' || typeof event.transcript !== 'string' || !event.transcript.trim()) return
          if (completedInputs.has(event.item_id)) return
          completedInputs.add(event.item_id)
          // Exact UI-equivalent transport controls; this does not route Skills
          // or classify business requests by keywords. Mixed/ambiguous messages
          // still go through M01 as a new question.
          const speechOnly = ['先别说', '先别说话', '先不要说', '先不要说话', '暂停播报', '停止播报'].includes(event.transcript.replace(/[\s，。！？,.!?]/g, ''))
          if (speechOnly && searchTurn && searchOwner) {
            searchOwner.silent = true; visibleSilentOwner = searchOwner; retainedSearches.add(searchTurn)
          } else {
            if (searchOwner) searchOwner.revoked = true
            searchTurn?.finish('cancelled')
            for (const retained of retainedSearches) retained.finish('cancelled')
            retainedSearches.clear()
          }
          turnId = randomUUID(); toolCount = 0
          responseSeen = false; userSpeaking = false; hintActive = false
          searchTurn = null; searchOwner = null
          deps.memoryConfirmations?.revoke(sender.id)
          sourceTurns.set(event.item_id, turnId)
          const source = deps.conversations.append({ sessionId, turnId, role: 'user', body: event.transcript, status: 'final' })
          const sourceTurnId = turnId
          tools = new R1ConversationTools(deps.db, deps.assets, deps.tasks, { source, selectedArtifact, selectedCandidate, sourceMessages: deps.conversations.messages(sessionId).slice(-20), temporary, realtimeSimpleSearch: true,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, persistenceConfirmed: false,
            assertCurrent() { assertCurrent(); if (turnId !== sourceTurnId) throw new Error('REALTIME_TOOL_SOURCE_REPLACED') },
            onMemoryInvalidated: deps.onMemoryInvalidated ? epoch => { invalidatedEpoch = epoch } : undefined,
            requestMemoryConfirmation: deps.memoryConfirmations ? (candidate, sensitive) => deps.memoryConfirmations!.offer(candidate, {
              ownerId: sender.id, source, temporary, sensitive, assertCurrent() {
                assertCurrent(); if (turnId !== sourceTurnId) throw new Error('MEMORY_CONFIRMATION_STALE')
              }
            }) : undefined }, taskAliases, deps.focusServices, artifacts, deps.music)
          nativeSkills.forEach(skillId => tools!.loadedSkillIds.add(skillId))
          const generation = inputGeneration
          const owner = searchOwner = { revoked: false, silent: false }
          if (deps.search && deps.pages) searchTurn = new RealtimeSearchTurn(sourceTurnId, {
            assets: deps.assets, search: deps.search, reader: deps.pages,
            assertCurrent() { assertCurrent(); if (owner.revoked) throw new Error('REALTIME_TOOL_SOURCE_REPLACED') },
            emit(state) {
              if (generation === inputGeneration || visibleSilentOwner === owner) emit(sender, id, state)
              if (generation === inputGeneration && state.hint && !owner.silent && !responseSeen && !userSpeaking && hintAudio) {
                responseSeen = true
                const responseId = `search-hint:${randomUUID()}`
                for (const event of [
                  { type: 'response.output_text.done', response_id: responseId, text: '我查一下。' },
                  { type: 'response.output_audio.delta', response_id: responseId, delta: hintAudio.toString('base64') },
                  { type: 'response.output_audio.done', response_id: responseId }
                ]) { playback.receive(event, sourceTurnId); emit(sender, id, event) }
              }
            },
            save(receipt) {
              if (!temporary) deps.db.prepare('INSERT OR IGNORE INTO receipts(action_id,entity_id,entity_version,status,actual_result_json,created_at) VALUES (?,?,?,?,?,?)')
                .run(receipt.actionId as string, null, null, receipt.status as string, JSON.stringify(receipt), new Date().toISOString())
            }
          })
          connection.updateBoundary(boundary())
        }
        emit(sender, id, event)
        if (event.type === 'response.done') extractMemory(event.response_id)
      },
      onToolCalls(calls) {
        assertCurrent()
        if (!tools || toolCount + calls.length > 6) { connection.close('REALTIME_TOOL_SOURCE_OR_BUDGET_INVALID'); return }
        const ownerTools = tools, sourceTurn = turnId, generation = inputGeneration, ownerSearch = searchTurn
        toolCount += calls.length
        void (async () => {
        const results = []
        // Search/page operations are read-only and use a shared concurrency gate.
        // Skill loading remains a separate decision, enforced by the boundary.
        const execute = async (call: typeof calls[number]) => {
          if (sourceTurn !== turnId || tools !== ownerTools) throw new Error('REALTIME_TOOL_SOURCE_REPLACED')
          const result = ['web_search', 'web_read_page'].includes(call.name) && ownerSearch
            ? await ownerSearch.execute(call.name, call.arguments, call.callId)
            : await ownerTools.executeAsync(call.name, call.arguments, call.callId)
          return { callId: call.callId, result }
        }
        for (let index = 0; index < calls.length;) {
          const call = calls[index]
          if (['web_search', 'web_read_page'].includes(call.name)) {
            const reads = []
            while (index < calls.length && ['web_search', 'web_read_page'].includes(calls[index].name)) reads.push(calls[index++])
            results.push(...await Promise.all(reads.map(execute)))
          } else { results.push(await execute(call)); index++ }
          if (ownerTools.memoryMutationReceipt) {
            // Do not ask a cloud session containing revoked facts to generate the acknowledgement.
            const reply = memoryMutationReply(results.at(-1)!.result), responseId = randomUUID()
            deps.conversations.append({ sessionId, turnId, responseId, role: 'assistant', body: reply, status: 'generated' })
            emit(sender, id, { type: 'response.output_text.done', response_id: responseId, text: reply })
            connection.close('MEMORY_CONTEXT_REFRESH_REQUIRED')
            deps.onMemoryInvalidated!(invalidatedEpoch!)
            return
          }
        }
        if (sourceTurn !== turnId || tools !== ownerTools || inputGeneration !== generation) throw new Error('REALTIME_TOOL_SOURCE_REPLACED')
        connection.updateBoundary(boundary(), false)
        connection.returnToolResults(results)
        })().catch(() => {
          if (sourceTurn !== turnId || inputGeneration !== generation) { connection.abandonToolCalls(calls.map(call => call.callId)); return }
          connection.close('REALTIME_CONTEXT_REFRESH_REQUIRED')
        })
      },
      onClosed(code) {
        hintAbort.abort()
        searchTurn?.finish('cancelled')
        for (const retained of retainedSearches) retained.finish('cancelled')
        try { assertCurrent(); playback.interruptPending() } catch {
          if (['REALTIME_PROTOCOL_OR_CONTEXT_INVALID', 'REALTIME_CONTEXT_INVALIDATED'].includes(code)) code = 'REALTIME_CONTEXT_REFRESH_REQUIRED'
        }
        if (sessions.get(sender.id)?.id === id) sessions.delete(sender.id)
        sender.removeListener('destroyed', destroyed)
        emit(sender, id, { type: 'closed', code, diagnostics: connection.getDiagnostics() })
      }
    })
    sessions.set(sender.id, { id, session: connection, silenceSearch() {
      if (searchTurn && searchOwner) {
        inputGeneration++; searchOwner.silent = true; visibleSilentOwner = searchOwner; retainedSearches.add(searchTurn)
      }
    }, playback(input) {
      assertCurrent(); playback.playback(input)
      if (input.status === 'completed') extractMemory(input.responseId)
    } }); sender.once('destroyed', destroyed)
    try {
      await connection.open()
      if (deps.searchHint) void deps.searchHint({ voice: persona.voiceId || process.env.VOLCENGINE_REALTIME_VOICE || '', configurationRevision: revision,
        boundary: new R1ModelRequestBoundary(deps.assets, persona, context(), [], 'realtime', assertCurrent), signal: hintAbort.signal })
        .then(buffer => { if (!hintAbort.signal.aborted) hintAudio = buffer }).catch(() => undefined)
      return { ok: true, data: { connectionId: id } }
    }
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
        } else if (action === 'Cancel') { active.silenceSearch(); active.session.cancelResponse() }
        else { active.session.close(); return { ok: true, data: { diagnostics: active.session.getDiagnostics() } } }
        return { ok: true, data: null }
      } catch (error) {
        const code = error instanceof Error && error.message === 'REALTIME_CONTEXT_INVALIDATED' ? 'REALTIME_CONTEXT_REFRESH_REQUIRED' : 'REALTIME_COMMAND_FAILED'
        active.session.close(code); return fail(code)
      }
    })
  }
  return { close(code = 'REALTIME_STOPPED') { for (const active of [...sessions.values()]) active.session.close(code) } }
}
