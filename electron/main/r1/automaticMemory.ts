import type { createArkResponsesProvider } from '../providers/arkResponsesProvider.js'
import { afterTransactionCommit, inTransaction, type R1Database } from './database.js'
import { R1MemoryStore } from './memory.js'
import { R1MemoryPolicy, type MemoryPolicy } from './memoryPolicy.js'
import { R1MemoryExtractionBoundary } from './memoryExtractionBoundary.js'
import { memoryContextCutoff } from './memoryContext.js'
import { isSensitiveMemory, memoryView, type MemorySaveCandidate } from './memoryTools.js'
import type { SessionMessage, R1Conversations } from './conversations.js'
import type { R1PromptAssets } from './promptAssets.js'
import type { R1Persona } from './persona.js'

type Candidate = { content: string; category: import('./memory.js').R1Memory['category']; sourceTurnIds: string[];
  validUntil: string | null; supersedesMemoryIds: string[] }
type Candidates = { candidates: Candidate[]; sensitiveSourceTurnIds: string[] }
export type AutomaticMemoryState = { state: 'disabled' | 'idle' | 'processing' | 'unavailable' | 'failed'; code: string | null; queued: number }
export type AutomaticMemoryScope = { source: SessionMessage; temporary: boolean; timezone: string;
  assertSession(): void; assertLatest(): void; confirmSensitive(candidate: MemorySaveCandidate): void }
type Job = { scope: AutomaticMemoryScope; authorization: MemoryPolicy; epoch: number; personaVersion: number; configurationRevision: number }
const safeCode = (error: unknown): string => error instanceof Error && /^[A-Z][A-Z0-9_:]{1,100}$/.test(error.message) ? error.message : 'AUTO_MEMORY_EXTRACTION_FAILED'

/** Optional background extraction. No backfill, durable candidates or host tools. */
export class R1AutomaticMemory {
  private readonly policy: R1MemoryPolicy
  private readonly memory: R1MemoryStore
  private readonly queue: Job[] = []
  private readonly seen = new Set<string>()
  private running = false
  private controller: AbortController | null = null
  private closed = false
  private state: AutomaticMemoryState = { state: 'disabled', code: null, queued: 0 }
  private readonly listeners = new Set<(state: AutomaticMemoryState) => void>()
  constructor(private readonly db: R1Database, private readonly assets: R1PromptAssets,
    private readonly conversations: R1Conversations, private readonly provider: ReturnType<typeof createArkResponsesProvider>,
    private readonly options: { persona(): R1Persona; configurationRevision(): number; onInvalidated(epoch: number): void; onSaved(): void }) {
    this.policy = new R1MemoryPolicy(db); this.memory = new R1MemoryStore(db)
    this.state.state = this.policy.get().enabled ? 'idle' : 'disabled'
  }
  getPolicy(): MemoryPolicy { return this.policy.get() }
  assertAuthorized(version: number): void { this.policy.assertAuthorized(version) }
  getState(): AutomaticMemoryState { return { ...this.state, queued: this.queue.length } }
  onChanged(listener: (state: AutomaticMemoryState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(state: AutomaticMemoryState['state'], code: string | null = null): void {
    this.state = { state, code, queued: this.queue.length }
    for (const listener of this.listeners) { try { listener(this.getState()) } catch { /* Status delivery is best effort. */ } }
  }
  updatePolicy(input: Parameters<R1MemoryPolicy['update']>[0]): MemoryPolicy {
    const previous = this.policy.get(), next = this.policy.update(input)
    if (next.version !== previous.version) this.invalidate()
    return next
  }
  invalidate(): void {
    this.controller?.abort(); this.queue.length = 0
    this.publish(this.policy.get().enabled ? 'idle' : 'disabled')
  }
  enqueue(scope: AutomaticMemoryScope): void {
    const authorization = this.policy.get()
    if (this.closed || scope.temporary || !authorization.enabled || this.seen.has(scope.source.messageId)) return
    if (scope.source.role !== 'user') return
    try { scope.assertSession(); this.checkSource(scope.source) } catch { return }
    if (this.queue.length >= 50) { this.publish('failed', 'AUTO_MEMORY_QUEUE_FULL'); return }
    this.seen.add(scope.source.messageId)
    this.queue.push({ scope: { ...scope, source: structuredClone(scope.source) }, authorization,
      epoch: this.memory.currentDeletionEpoch(), personaVersion: this.options.persona().version, configurationRevision: this.options.configurationRevision() })
    void this.drain()
  }
  private checkSource(source: SessionMessage): void {
    const row = this.db.prepare(`SELECT m.rowid AS sequence, m.body, m.session_id, m.turn_id, m.status FROM messages m JOIN sessions s ON s.session_id = m.session_id
      WHERE m.message_id = ? AND m.role = 'user' AND s.temporary = 0 AND s.status <> 'memory_source'`).get(source.messageId) as { sequence: number; body: string; session_id: string; turn_id: string; status: string } | undefined
    if (!row || row.body !== source.body || row.session_id !== source.sessionId || row.turn_id !== source.turnId || row.status !== 'final' || row.sequence <= memoryContextCutoff(this.db) ||
      this.db.prepare('SELECT 1 FROM source_suppression WHERE source_ref IN (?, ?)').get(source.messageId, source.turnId)) throw new Error('AUTO_MEMORY_SOURCE_REVOKED')
  }
  private assertCurrent(job: Job): void {
    if (this.closed || this.controller?.signal.aborted) throw new Error('AUTO_MEMORY_CANCELLED')
    this.policy.assertAuthorized(job.authorization.version)
    if (this.memory.currentDeletionEpoch() !== job.epoch || this.options.persona().version !== job.personaVersion ||
      this.options.configurationRevision() !== job.configurationRevision) throw new Error('AUTO_MEMORY_CONTEXT_REVOKED')
    job.scope.assertSession(); this.checkSource(job.scope.source)
  }
  private async extract(job: Job): Promise<void> {
    this.assertCurrent(job)
    const existing = this.memory.list().entries
    const current = this.conversations.modelTurns(job.scope.source.sessionId)
    const sourceIndex = current.findIndex(turn => turn.turnId === job.scope.source.turnId && turn.role === 'user')
    const previous = current[sourceIndex - 1]
    const source = job.scope.source
    const sourceMessages = [...(previous?.role === 'assistant' && previous.status === 'valid' && previous.text.trim() ? [previous] : []),
      { turnId: source.turnId, role: 'user', text: source.body, heardText: null, status: 'valid' }]
    const input = { temporary: false, autoMemoryEnabled: true, authorizationVersion: job.authorization.version, deletionEpoch: job.epoch,
      currentTime: source.createdAt, timezone: job.scope.timezone, sourceMessages, existingMemories: existing.map(memoryView) }
    const boundary = new R1MemoryExtractionBoundary(this.assets, input, () => this.assertCurrent(job))
    const response = await this.provider.request({ boundary, messages: [], signal: this.controller!.signal, maxOutputTokens: 4096 })
    this.assertCurrent(job)
    let result: Candidates
    try { result = JSON.parse(response.text) } catch { throw new Error('AUTO_MEMORY_OUTPUT_INVALID') }
    this.assets.validateStructured('memory-candidates', result)
    const sensitiveTurns = new Set(result.sensitiveSourceTurnIds)
    // Supplemental write protection, not semantic classification or an action router.
    if (result.candidates.length && isSensitiveMemory(source.body, '')) sensitiveTurns.add(source.turnId)
    if ([...sensitiveTurns].some(id => id !== source.turnId)) throw new Error('AUTO_MEMORY_SOURCE_INVALID')
    // Preflight the entire proposal before committing any entity.
    for (const candidate of result.candidates) {
      if (!candidate.sourceTurnIds.length || candidate.sourceTurnIds.some(id => id !== source.turnId)) throw new Error('AUTO_MEMORY_SOURCE_INVALID')
      this.memory.validateCandidate({ content: candidate.content, category: candidate.category, expiresAt: candidate.validUntil })
      if (candidate.supersedesMemoryIds.length > 1 || candidate.supersedesMemoryIds.some(id => !existing.some(memory => memory.memoryId === id))) throw new Error('AUTO_MEMORY_TARGET_INVALID')
      if (isSensitiveMemory(source.body, candidate.content)) sensitiveTurns.add(source.turnId)
    }
    let epoch = job.epoch, saved = false
    inTransaction(this.db, () => {
      this.assertCurrent(job)
      for (const candidate of result.candidates) {
        // PR05 marks sensitivity at source-turn granularity. Mixed turns require explicit selection.
        if (sensitiveTurns.has(source.turnId)) continue
        const target = existing.find(memory => memory.memoryId === candidate.supersedesMemoryIds[0])
        // A correction invalidates earlier contexts; execute it once and drop other proposals from that context.
        if (target) {
          const updated = this.memory.updateAutomatically({ memoryId: target.memoryId, expectedVersion: target.version,
            content: candidate.content, category: candidate.category, sourceMessageIds: [source.messageId], expiresAt: candidate.validUntil,
            authorizationVersion: job.authorization.version })
          epoch = updated.deletionEpoch; saved = true; break
        }
        this.memory.rememberAutomatically({ content: candidate.content, category: candidate.category, sourceMessageIds: [source.messageId],
          expiresAt: candidate.validUntil, authorizationVersion: job.authorization.version })
        saved = true
      }
      afterTransactionCommit(this.db, () => {
        if (epoch !== job.epoch) this.options.onInvalidated(epoch)
        if (saved) this.options.onSaved()
      })
    })
    if (sensitiveTurns.size && epoch === job.epoch) {
      this.assertCurrent(job); job.scope.assertLatest()
      // PR05 returns only source IDs. UI must select a single actual fact before a fixed-content confirmation.
      job.scope.confirmSensitive({ operation: 'remember', content: source.body, category: 'profile', validUntil: null })
    }
  }
  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (!this.closed && this.queue.length) {
        const job = this.queue.shift()!
        this.controller = new AbortController(); this.publish('processing')
        try { await this.extract(job); this.publish(this.policy.get().enabled ? 'idle' : 'disabled') }
        catch (error) {
          if (this.closed) break
          const code = safeCode(error)
          if (!this.policy.get().enabled) this.publish('disabled')
          else if (code.includes('REVOKED') || code.includes('CANCELLED') || code === 'ARK_REQUEST_CANCELLED') this.publish('idle')
          else this.publish(code === 'ARK_NOT_CONFIGURED' ? 'unavailable' : 'failed', code)
        } finally { this.controller = null }
      }
    } finally { this.running = false }
  }
  async whenIdle(): Promise<void> { while (this.running) await new Promise(resolve => setTimeout(resolve, 5)) }
  close(): void { this.closed = true; this.invalidate(); this.listeners.clear() }
}
