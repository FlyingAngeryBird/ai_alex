import type { ArkModelBoundary, createArkResponsesProvider } from '../providers/arkResponsesProvider.js'
import type { ChatMessage } from '../providers/llmProvider.js'
import { R1ModelRequestBoundary } from './modelBoundary.js'
import type { R1PromptAssets } from './promptAssets.js'
import type { R1Persona } from './persona.js'
import type { AppPreferences } from './preferences.js'
import type { R1TaskSupervisor, TaskEvent } from './taskSupervisor.js'

export type TaskDeliveryRequest = { taskId: string; goalVersion: number; resultId: string; requestId: string }
export type TaskDeliveryAudio = { text: string; audio: ArrayBuffer; mimeType: 'audio/wav' }
const keyOf = (value: Pick<TaskDeliveryRequest, 'taskId' | 'goalVersion' | 'resultId'>) => JSON.stringify([value.taskId, value.goalVersion, value.resultId])

/** New completion events only. No history replay, retries, tools or extra user authority. */
export class R1TaskDelivery {
  private eligible = new Map<string, string>()
  private seen = new Set<string>()
  private active = new Map<number, { requestId: string; abort: AbortController }>()
  constructor(private readonly options: {
    assets: R1PromptAssets; tasks: Pick<R1TaskSupervisor, 'list' | 'contextIsCurrent'>;
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
  }
  invalidate(): void { for (const owner of this.active.keys()) this.cancel(owner); this.eligible.clear() }
  async prepare(owner: number, request: TaskDeliveryRequest): Promise<TaskDeliveryAudio | null> {
    if (!request || typeof request !== 'object' || typeof request.taskId !== 'string' || request.taskId.length > 160 ||
      typeof request.resultId !== 'string' || request.resultId.length > 160 || !Number.isSafeInteger(request.goalVersion) ||
      request.goalVersion < 1 || typeof request.requestId !== 'string' || !/^[\w-]{1,160}$/.test(request.requestId)) throw new Error('TASK_DELIVERY_INPUT_INVALID')
    const key = keyOf(request), eventId = this.eligible.get(key)
    const scope = { ...this.options.scope() }, revision = this.options.configurationRevision(), persona = structuredClone(this.options.persona())
    const preferences = { ...this.options.preferences() }
    const voice = persona.voiceId || process.env.VOLCENGINE_REALTIME_VOICE || ''
    if (!eventId || preferences.doNotDisturb || !preferences.proactiveSpeechEnabled || !voice ||
      !process.env.VOLCENGINE_REALTIME_API_KEY || !process.env.VOLCENGINE_ARK_API_KEY || !process.env.VOLCENGINE_ARK_MODEL) return null
    this.cancel(owner)
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000)
    this.active.set(owner, { requestId: request.requestId, abort: controller })
    const current = () => {
      const latestScope = this.options.scope(), latestPreferences = this.options.preferences()
      if (controller.signal.aborted || scope.temporary !== latestScope.temporary || scope.sessionId !== latestScope.sessionId ||
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
      return { text, audio, mimeType: 'audio/wav' }
    } finally {
      clearTimeout(timeout)
      if (this.active.get(owner)?.requestId === request.requestId) this.active.delete(owner)
      controller.abort()
    }
  }
}
