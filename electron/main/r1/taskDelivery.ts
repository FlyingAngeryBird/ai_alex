import type { ArkModelBoundary, createArkResponsesProvider } from '../providers/arkResponsesProvider.js'
import type { ChatMessage } from '../providers/llmProvider.js'
import { R1ModelRequestBoundary } from './modelBoundary.js'
import type { R1PromptAssets } from './promptAssets.js'
import type { R1Persona } from './persona.js'
import type { AppPreferences } from './preferences.js'
import type { R1TaskSupervisor, TaskEvent } from './taskSupervisor.js'
import { randomUUID } from 'node:crypto'
import type { R1Conversations } from './conversations.js'
import { NativePlaybackLedger } from './nativePlayback.js'

export type TaskDeliveryRequest = { taskId: string; goalVersion: number; resultId: string; requestId: string }
export type TaskDeliveryAudio = { text: string; audio: ArrayBuffer; mimeType: 'audio/wav'; responseId: string }
export type TaskDeliveryPlayback = { requestId: string; status: 'started' | 'playing' | 'completed' | 'interrupted'; playedUntilMs: number }
const keyOf = (value: Pick<TaskDeliveryRequest, 'taskId' | 'goalVersion' | 'resultId'>) => JSON.stringify([value.taskId, value.goalVersion, value.resultId])

/** New completion events only. No history replay, retries, tools or extra user authority. */
export class R1TaskDelivery {
  private eligible = new Map<string, string>()
  private seen = new Set<string>()
  private active = new Map<number, { requestId: string; abort: AbortController }>()
  private playback = new Map<string, { owner: number; ledger: NativePlaybackLedger; responseId: string;
    started: boolean; check(): unknown; timer: ReturnType<typeof setTimeout> }>()
  constructor(private readonly options: {
    assets: R1PromptAssets; tasks: Pick<R1TaskSupervisor, 'list' | 'contextIsCurrent'>; conversations: R1Conversations;
    provider: ReturnType<typeof createArkResponsesProvider>; persona(): R1Persona; preferences(): AppPreferences;
    scope(): { temporary: boolean; sessionId?: string | null }; configurationRevision(): number;
    synthesize(input: { text: string; voice: string; boundary: R1ModelRequestBoundary; signal: AbortSignal }): Promise<ArrayBuffer>
  }) {}
  observe(event: TaskEvent): void {
    for (const key of this.eligible.keys()) if (JSON.parse(key)[0] === event.task.taskId &&
      (JSON.parse(key)[1] !== event.task.goalVersion || JSON.parse(key)[2] !== event.task.resultId ||
        !['succeeded', 'partially_succeeded', 'waiting_input'].includes(event.task.status))) this.eligible.delete(key)
    if (!['completed', 'waiting_input'].includes(event.reason) || !event.task.result || event.task.status === 'failed') return
    const key = keyOf({ ...event.task, resultId: event.task.result.resultId })
    if (this.seen.has(key)) return
    this.seen.add(key)
    const preferences = this.options.preferences()
    if (preferences.doNotDisturb || !preferences.proactiveSpeechEnabled) return
    this.eligible.set(key, event.eventId)
    // Result cards and the task panel retain every result; speech is a bounded opportunistic notification.
    if (this.eligible.size > 5) this.eligible.delete(this.eligible.keys().next().value!)
  }
  cancel(owner: number, requestId?: string): void {
    const pending = this.active.get(owner)
    if (pending && (!requestId || pending.requestId === requestId)) { pending.abort.abort(); this.active.delete(owner) }
    for (const [id, playback] of this.playback) if (playback.owner === owner && (!requestId || id === requestId)) {
      playback.ledger.interruptPending(); clearTimeout(playback.timer); this.playback.delete(id)
    }
  }
  invalidate(): void {
    for (const owner of new Set([...this.active.keys(), ...[...this.playback.values()].map(value => value.owner)])) this.cancel(owner)
    this.eligible.clear()
  }
  reportPlayback(owner: number, input: TaskDeliveryPlayback): void {
    if (!input || typeof input.requestId !== 'string' || !Number.isSafeInteger(input.playedUntilMs) ||
      !['started', 'playing', 'completed', 'interrupted'].includes(input.status)) throw new Error('TASK_DELIVERY_PLAYBACK_INVALID')
    const receipt = this.playback.get(input.requestId)
    if (!receipt) return // A cancelled/expired response cannot become heard again.
    if (receipt.owner !== owner) throw new Error('TASK_DELIVERY_OWNER_MISMATCH')
    if (['playing', 'completed'].includes(input.status) && !receipt.started) throw new Error('TASK_DELIVERY_PLAYBACK_NOT_STARTED')
    if (input.status !== 'interrupted') {
      try { receipt.check() } catch { this.cancel(owner, input.requestId); return }
    }
    receipt.ledger.playback({ responseId: receipt.responseId, playedUntilMs: input.playedUntilMs, status: input.status })
    if (input.status === 'started') receipt.started = true
    if (input.status === 'completed' || input.status === 'interrupted') { clearTimeout(receipt.timer); this.playback.delete(input.requestId) }
  }
  async prepare(owner: number, request: TaskDeliveryRequest): Promise<TaskDeliveryAudio | null> {
    if (!request || typeof request !== 'object' || typeof request.taskId !== 'string' || request.taskId.length > 160 ||
      typeof request.resultId !== 'string' || request.resultId.length > 160 || !Number.isSafeInteger(request.goalVersion) ||
      request.goalVersion < 1 || typeof request.requestId !== 'string' || !/^[\w-]{1,160}$/.test(request.requestId)) throw new Error('TASK_DELIVERY_INPUT_INVALID')
    const key = keyOf(request), eventId = this.eligible.get(key)
    const scope = { ...this.options.scope() }, revision = this.options.configurationRevision(), persona = structuredClone(this.options.persona())
    const preferences = { ...this.options.preferences() }
    const voice = persona.voiceId || process.env.VOLCENGINE_REALTIME_VOICE || ''
    if (!eventId || !scope.sessionId || preferences.doNotDisturb || !preferences.proactiveSpeechEnabled || !voice ||
      !process.env.VOLCENGINE_REALTIME_API_KEY || !process.env.VOLCENGINE_ARK_API_KEY || !process.env.VOLCENGINE_ARK_MODEL) return null
    this.cancel(owner)
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000)
    this.active.set(owner, { requestId: request.requestId, abort: controller })
    const current = (afterPreparation = false) => {
      const latestScope = this.options.scope(), latestPreferences = this.options.preferences()
      if ((!afterPreparation && controller.signal.aborted) || scope.temporary !== latestScope.temporary || scope.sessionId !== latestScope.sessionId ||
        this.options.configurationRevision() !== revision || this.options.persona().version !== persona.version ||
        latestPreferences.version !== preferences.version || latestPreferences.doNotDisturb || !latestPreferences.proactiveSpeechEnabled) throw new Error('TASK_DELIVERY_REVOKED')
      const task = this.options.tasks.list(scope.temporary ? scope.sessionId || '__missing__' : null).find(task => task.taskId === request.taskId)
      if (!task || !this.options.tasks.contextIsCurrent(task.taskId) || task.goalVersion !== request.goalVersion ||
        task.resultId !== request.resultId || task.result?.resultId !== request.resultId || task.result?.goalVersion !== request.goalVersion ||
        !['succeeded', 'partially_succeeded', 'waiting_input'].includes(task.status)) throw new Error('TASK_DELIVERY_STALE')
      return task
    }
    try {
      const task = current(), result = task.result!
      this.eligible.delete(key) // Once attempted, interruption/failure never causes automatic replay.
      const delivery = { eventId, taskId: task.taskId, goalVersion: task.goalVersion, resultId: result.resultId,
        speakAllowed: true, completionStatus: result.completionStatus, replyBrief: result.replyBrief,
        sourceRefs: result.sourceRefs, artifactIds: result.artifacts.map(artifact => artifact.artifactId), entityReceipts: result.entityReceipts }
      const systemText = this.options.assets.compile('taskDelivery', { persona_json: persona, delivery_json: delivery }).text
      const boundary: ArkModelBoundary = { systemText, assertCurrent: current,
        finalize: (_messages: ChatMessage[]) => { current(); return { messages: [{ role: 'system', content: systemText },
          { role: 'user', content: JSON.stringify({ type: 'task_result_event', data: delivery }) }], tools: [] } },
        validateToolCall() { throw new Error('TASK_DELIVERY_TOOLS_FORBIDDEN') } }
      const response = await this.options.provider.request({ boundary, messages: [], signal: controller.signal, maxOutputTokens: 2048 })
      current()
      const text = response.text.trim()
      const ids = [task.taskId, result.resultId, ...result.artifacts.map(a => a.artifactId), ...result.sourceRefs]
      if (!text || [...text].length > 500 || /https?:\/\/|```/.test(text) || ids.some(id => id.length >= 8 && text.includes(id))) throw new Error('TASK_DELIVERY_TEXT_INVALID')
      const context = { sessionId: scope.sessionId || 'task-delivery', sessionGeneration: 1, turnId: request.requestId,
        currentTime: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, temporary: scope.temporary,
        contextVersion: 1, personaVersion: persona.version, deletionEpoch: 0, selectedEntity: null,
        availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: [], memories: [], activeTasks: [] }
      const ttsBoundary = new R1ModelRequestBoundary(this.options.assets, persona, context, [], 'realtime', current, true)
      const audio = await this.options.synthesize({ text, voice, boundary: ttsBoundary, signal: controller.signal })
      current()
      // Register generated text separately from actual device playback. Reuse the
      // native ledger's exact PCM duration checks and interrupted-history rules.
      const wav = Buffer.from(audio)
      if (wav.length < 46 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 36, 40) !== 'data' ||
        wav.readUInt32LE(24) !== 24000 || wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16 ||
        wav.readUInt32LE(40) !== wav.length - 44 || wav.length > 2160044 || (wav.length - 44) % 2) throw new Error('TASK_DELIVERY_AUDIO_INVALID')
      const responseId = `task-delivery:${randomUUID()}`, ledger = new NativePlaybackLedger(this.options.conversations, scope.sessionId)
      ledger.receive({ type: 'response.output_text.done', response_id: responseId, text }, request.requestId)
      for (let offset = 44; offset < wav.length; offset += 48000) {
        ledger.receive({ type: 'response.output_audio.delta', response_id: responseId,
          delta: wav.subarray(offset, offset + 48000).toString('base64') }, request.requestId)
      }
      ledger.receive({ type: 'response.output_audio.done', response_id: responseId }, request.requestId)
      // Generation cancellation is no longer relevant after preparation has
      // returned. Context/version checks still apply throughout playback.
      const playbackCheck = () => current(true)
      const timer = setTimeout(() => this.cancel(owner, request.requestId), 60000)
      timer.unref?.()
      this.playback.set(request.requestId, { owner, ledger, responseId, started: false, check: playbackCheck, timer })
      return { text, audio, mimeType: 'audio/wav', responseId }
    } finally {
      clearTimeout(timeout)
      if (this.active.get(owner)?.requestId === request.requestId) this.active.delete(owner)
      controller.abort()
    }
  }
}
