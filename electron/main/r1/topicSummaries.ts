import { Ajv } from 'ajv'
import type { ChatMessage } from '../providers/llmProvider.js'
import type { createArkResponsesProvider } from '../providers/arkResponsesProvider.js'
import type { R1Database } from './database.js'
import { R1Topics, topicContext, type ContextSummary, type R1Topic } from './topics.js'
import { R1MemoryStore } from './memory.js'
import { R1MemoryPolicy } from './memoryPolicy.js'
import { memoryContextCutoff } from './memoryContext.js'
import type { R1Conversations, SessionMessage } from './conversations.js'
import type { R1PromptAssets, R1ModelTool } from './promptAssets.js'
import { isSensitiveMemory } from './memoryTools.js'
export type TopicSummaryState = { state: 'idle' | 'processing' | 'failed'; code: string | null }
export class R1TopicSummaryBoundary {
  readonly systemText: string
  readonly outputFormat: { name: string; schema: Record<string, unknown> }
  constructor(assets: R1PromptAssets, private readonly input: Record<string, unknown>, private readonly check: () => void) {
    this.systemText = assets.compile('summary', { summary_input_json: input }).text
    const schema = assets.structuredSchema('context-summary')
    const properties = schema.properties as Record<string, any>
    if (Object.hasOwn(input, 'existingTopics')) schema.required = [...new Set([...(schema.required as string[]), 'topic'])]
    const sources = input.sourceMessages as Array<{ turnId: string; role: string }>
    const sourceIds = [...new Set(sources.filter(source => source.role === 'user').map(source => source.turnId))]
    if (sourceIds.length) properties.sourceTurnIds.items.enum = sourceIds
    else properties.sourceTurnIds.maxItems = 0
    const memories = input.memories as Array<{ memoryId: string }>
    if (memories.length) properties.memoryIds.items.enum = memories.map(memory => memory.memoryId)
    else properties.memoryIds.maxItems = 0
    const tasks = input.taskSnapshots as Array<{ taskId: string }>
    if (tasks.length) properties.taskFacts.items.properties.taskId.enum = tasks.map(task => task.taskId)
    else properties.taskFacts.maxItems = 0
    const existing = input.existingTopics as Array<{ topicId: string; version: number }> | undefined
    const topic = properties.topic.anyOf.find((item: { type: string }) => item.type === 'object')
    topic.properties.topicId.anyOf = existing?.length ? [{ type: 'string', enum: existing.map(value => value.topicId) }, { type: 'null' }] : [{ type: 'null' }]
    topic.properties.expectedVersion.anyOf = existing?.length ? [{ type: 'integer', enum: [...new Set(existing.map(value => value.version))] }, { type: 'null' }] : [{ type: 'null' }]
    this.outputFormat = { name: 'context_summary', schema }
  }
  finalize(_messages: ChatMessage[]): { messages: ChatMessage[]; tools: R1ModelTool[] } {
    this.assertCurrent(); return { messages: [{ role: 'system', content: this.systemText }, { role: 'user', content: JSON.stringify(this.input.sourceMessages) }], tools: [] }
  }
  assertCurrent(): void { this.check() }
  validateToolCall(): never { throw new Error('SUMMARY_TOOLS_FORBIDDEN') }
}
type Scope = { source: SessionMessage; temporary: boolean; requireHeardAssistant?: boolean; assertSession(): void }
type Job = { scope: Scope; version: number; epoch: number; personaVersion: number; configurationRevision: number; sources: SessionMessage[]; existing: R1Topic[] }
export class R1TopicSummaries {
  private readonly policy: R1MemoryPolicy
  private readonly topics: R1Topics
  private readonly queue: Job[] = []
  private readonly checkpoints = new Map<string, string>()
  private activeSession: string | null = null
  private activeSource: string | null = null
  private readonly deferred = new Map<string, Scope>()
  private running = false
  private closed = false
  private controller: AbortController | null = null
  private state: TopicSummaryState = { state: 'idle', code: null }
  constructor(private readonly db: R1Database, private readonly assets: R1PromptAssets, private readonly conversations: R1Conversations,
    private readonly provider: ReturnType<typeof createArkResponsesProvider>, private readonly options: { personaVersion(): number;
      configurationRevision(): number; onChanged(): void; onInvalidated(epoch: number): void }) {
    this.policy = new R1MemoryPolicy(db); this.topics = new R1Topics(db)
  }
  getState(): TopicSummaryState { return { ...this.state } }
  private publish(state: TopicSummaryState['state'], code: string | null = null) { this.state = { state, code }; this.options.onChanged() }
  invalidate(): void { this.controller?.abort(); this.queue.length = 0; this.deferred.clear(); this.checkpoints.clear(); this.publish('idle') }
  enqueue(scope: Scope): void {
    if (this.closed || scope.temporary || scope.source.role !== 'user') return
    const policy = this.policy.get()
    if (!policy.enabled) return
    try { scope.assertSession() } catch { return }
    const pending = this.queue.find(job => job.scope.source.sessionId === scope.source.sessionId)
    if (this.activeSession === scope.source.sessionId || pending) {
      if ((pending?.scope.source.messageId ?? this.activeSource) !== scope.source.messageId)
        this.deferred.set(scope.source.sessionId, { ...scope, source: structuredClone(scope.source) })
      return
    }
    const baseline = (this.db.prepare('SELECT authorized_after_rowid AS sequence FROM memory_policy WHERE id=1').get() as { sequence: number }).sequence
    const eligible = new Set((this.db.prepare('SELECT message_id FROM messages WHERE session_id=? AND rowid > ?').all(scope.source.sessionId,
      Math.max(baseline, memoryContextCutoff(this.db))) as { message_id: string }[]).map(row => row.message_id))
    const validTurns = new Set(this.conversations.modelTurns(scope.source.sessionId).filter(turn => turn.status === 'valid' && turn.text.trim()).map(turn => `${turn.turnId}:${turn.role}`))
    const messages = this.conversations.messages(scope.source.sessionId).filter(source => eligible.has(source.messageId) && validTurns.has(`${source.turnId}:${source.role}`) && source.role !== 'system' && (!scope.requireHeardAssistant || source.role !== 'assistant' || source.status === 'heard'))
    const checkpoint = this.checkpoints.get(scope.source.sessionId), previous = messages.findIndex(source => source.messageId === checkpoint)
    const threshold = Math.ceil(this.assets.summaryWindow().recentTurnLimit * this.assets.summaryWindow().triggerFraction)
    if (messages.slice(previous + 1).filter(source => source.role === 'user').length < threshold || !messages.some(source => source.messageId === scope.source.messageId)) return
    if (messages.some(source => isSensitiveMemory(source.body, ''))) return
    if (this.queue.length >= 5) { this.publish('failed', 'SUMMARY_QUEUE_FULL'); return }
    this.checkpoints.set(scope.source.sessionId, scope.source.messageId)
    this.queue.push({ scope: { ...scope, source: structuredClone(scope.source) }, version: policy.version,
      epoch: new R1MemoryStore(this.db).currentDeletionEpoch(), personaVersion: this.options.personaVersion(), configurationRevision: this.options.configurationRevision(),
      sources: messages.slice(-this.assets.summaryWindow().recentTurnLimit * 2), existing: this.topics.list().entries.slice(0, 5) })
    void this.drain()
  }
  private assertCurrent(job: Job): void {
    if (this.closed || this.controller?.signal.aborted) throw new Error('SUMMARY_CANCELLED')
    this.policy.assertAuthorized(job.version); job.scope.assertSession(); this.topics.validateSources(job.sources)
    const latest = this.conversations.messages(job.scope.source.sessionId).filter(source => source.role === 'user').at(-1)
    if (latest?.messageId !== job.scope.source.messageId) throw new Error('SUMMARY_SOURCE_REPLACED')
    if (new R1MemoryStore(this.db).currentDeletionEpoch() !== job.epoch || this.options.personaVersion() !== job.personaVersion ||
      this.options.configurationRevision() !== job.configurationRevision) throw new Error('SUMMARY_CONTEXT_REVOKED')
  }
  private async run(job: Job): Promise<void> {
    this.assertCurrent(job)
    const input = { temporary: false, contextVersion: job.version, deletionEpoch: job.epoch,
      sourceMessages: job.sources.map(source => ({ turnId: source.turnId, role: source.role, text: source.body,
        heardText: source.status === 'heard' ? source.body : null, status: 'valid' })), memories: [], taskSnapshots: [], receiptActionIds: [], existingTopics: job.existing.map(topicContext) }
    const boundary = new R1TopicSummaryBoundary(this.assets, input, () => this.assertCurrent(job))
    const response = await this.provider.request({ boundary, messages: [], signal: this.controller!.signal, maxOutputTokens: 4096 })
    this.assertCurrent(job)
    const validate = new Ajv({ strict: false }).compile(boundary.outputFormat.schema)
    const parse = (text: string): ContextSummary => {
      let result: unknown
      try { result = JSON.parse(text) } catch { throw new Error('SUMMARY_OUTPUT_INVALID') }
      this.assets.validateStructured('context-summary', result)
      if (!validate(result)) throw new Error('SUMMARY_OUTPUT_INVALID')
      return result as ContextSummary
    }
    let result: ContextSummary
    try { result = parse(response.text) }
    catch {
      this.assertCurrent(job)
      if ([...response.text].length > 20000) throw new Error('SUMMARY_OUTPUT_TOO_LARGE')
      const repairInput = { schemaId: 'context-summary', targetSchema: boundary.outputFormat.schema,
        invalidOutput: response.text, validationErrors: ['SUMMARY_OUTPUT_INVALID'],
        validReferenceIds: [...new Set(job.sources.filter(source => source.role === 'user').map(source => source.turnId)), ...job.existing.map(topic => topic.topicId)].slice(0, 50),
        sourceSnapshot: { sourceMessages: input.sourceMessages, existingTopics: input.existingTopics, memories: [], taskSnapshots: [] } }
      const systemText = this.assets.compile('repair', { repair_json: repairInput }).text
      const repairBoundary = { systemText, outputFormat: boundary.outputFormat,
        assertCurrent: () => this.assertCurrent(job), validateToolCall() { throw new Error('SUMMARY_TOOLS_FORBIDDEN') },
        finalize: (_messages: ChatMessage[]) => {
          this.assertCurrent(job)
          return { messages: [{ role: 'system' as const, content: systemText }, { role: 'user' as const, content: JSON.stringify(repairInput) }], tools: [] }
        } }
      const repaired = await this.provider.request({ boundary: repairBoundary, messages: [], signal: this.controller!.signal, maxOutputTokens: 4096 })
      this.assertCurrent(job)
      try { result = parse(repaired.text) } catch { throw new Error('STRUCTURED_OUTPUT_INVALID') }
    }
    if (!Object.hasOwn(result, 'topic')) throw new Error('SUMMARY_TOPIC_MISSING')
    if (result.topic && !/[\u3400-\u9fff]/u.test(result.summary)) throw new Error('SUMMARY_LANGUAGE_INVALID')
    if (result.topic && !result.sourceTurnIds.includes(job.scope.source.turnId)) throw new Error('SUMMARY_CURRENT_SOURCE_REQUIRED')
    const topic = this.topics.commitSummary({ result, sources: job.sources, existingTopics: job.existing,
      authorizationVersion: job.version, deletionEpoch: job.epoch, assertCurrent: () => this.assertCurrent(job) })
    if (topic && topic.deletionEpoch !== job.epoch) this.options.onInvalidated(topic.deletionEpoch)
  }
  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.closed && this.queue.length) {
        const job = this.queue.shift()!; this.controller = new AbortController(); this.activeSession = job.scope.source.sessionId; this.activeSource = job.scope.source.messageId; this.publish('processing')
        try { await this.run(job); if (!this.closed) this.publish('idle') }
        catch (error) {
          if (this.closed) break
          const code = error instanceof Error && /^[A-Z][A-Z0-9_:]{1,100}$/.test(error.message) ? error.message : 'SUMMARY_FAILED'
          if (code === 'SUMMARY_SOURCE_REPLACED') this.checkpoints.delete(job.scope.source.sessionId)
          this.publish(code.includes('REVOKED') || code.includes('CANCELLED') || code === 'SUMMARY_SOURCE_REPLACED' ? 'idle' : 'failed', code)
        } finally {
          this.controller = null; this.activeSession = null; this.activeSource = null
          const next = this.deferred.get(job.scope.source.sessionId)
          this.deferred.delete(job.scope.source.sessionId)
          if (next && !this.closed) { this.checkpoints.delete(job.scope.source.sessionId); this.enqueue(next) }
        }
      }
    } finally { this.running = false }
  }
  async whenIdle(): Promise<void> { while (this.running) await new Promise(resolve => setTimeout(resolve, 5)) }
  close(): void { this.closed = true; this.invalidate() }
}
