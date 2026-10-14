import { randomUUID, createHash } from 'node:crypto'
import { afterTransactionCommit, inTransaction, type R1Database } from './database.js'
import { R1Conversations, type SessionMessage } from './conversations.js'
import { R1MemoryStore, type R1Memory } from './memory.js'
import type { MemorySaveCandidate } from './memoryTools.js'

export type MemoryConfirmation = { confirmationId: string; operation: 'remember' | 'update'; content: string;
  category: R1Memory['category']; validUntil: string | null; temporary: boolean; sensitive: boolean; expiresAt: string; requiresSelection?: boolean }
export type ConfirmedMemory = { memory: R1Memory; temporary: false; sessionChanged: boolean }
type Context = { ownerId: number; source: SessionMessage; temporary: boolean; sensitive: boolean; automatic?: boolean; assertCurrent(): void }
type Pending = { view: MemoryConfirmation; candidate: MemorySaveCandidate; context: Context; fingerprint: string }

/** Candidates and confirmation authority stay in memory. IPC can submit only an opaque token. */
export class R1MemoryConfirmations {
  private readonly pending = new Map<string, Pending>()
  private readonly completed = new Map<string, { ownerId: number; result: ConfirmedMemory; expiresAt: number }>()
  private readonly cancelledSources = new Map<string, number>()
  private exitTemporary?: (sessionId: string) => void
  constructor(private readonly db: R1Database, private readonly options: {
    notify(ownerId: number, value: MemoryConfirmation | null): void;
    onInvalidated(epoch: number): void; onTemporaryExited(): void;
    now?: () => number;
  }) {}
  bindTemporaryExit(exit: (sessionId: string) => void): void { this.exitTemporary = exit }
  private now(): number { return this.options.now?.() ?? Date.now() }
  revoke(ownerId: number): void {
    let removed = false
    for (const [id, record] of this.pending) if (record.context.ownerId === ownerId) { this.pending.delete(id); removed = true }
    if (removed) this.options.notify(ownerId, null)
  }
  revokeAll(): void { for (const owner of new Set([...this.pending.values()].map(record => record.context.ownerId))) this.revoke(owner) }
  hasPendingForSource(sourceId: string): boolean { return [...this.pending.values()].some(record => record.context.source.messageId === sourceId) }
  revokeAutomatic(): void {
    for (const [id, record] of this.pending) if (record.context.automatic) { this.pending.delete(id); this.options.notify(record.context.ownerId, null) }
  }
  offerSelection(context: Context): MemoryConfirmation {
    context.assertCurrent(); this.prune()
    if (context.temporary || context.source.role !== 'user' || !context.ownerId) throw new Error('AUTO_MEMORY_SOURCE_INVALID')
    if (this.hasPendingForSource(context.source.messageId)) throw new Error('MEMORY_CONFIRMATION_ALREADY_PENDING')
    if (this.cancelledSources.has(`${context.ownerId}:${context.source.messageId}`)) throw new Error('MEMORY_CONFIRMATION_CANCELLED')
    this.revoke(context.ownerId)
    const view: MemoryConfirmation = { confirmationId: randomUUID(), operation: 'remember', content: context.source.body,
      category: 'profile', validUntil: null, temporary: false, sensitive: true, expiresAt: new Date(this.now() + 300_000).toISOString(), requiresSelection: true }
    this.pending.set(view.confirmationId, { view, candidate: { operation: 'remember', content: '', category: 'profile', validUntil: null },
      context: { ...context, source: structuredClone(context.source) }, fingerprint: `selection:${context.source.messageId}` })
    this.options.notify(context.ownerId, structuredClone(view)); return structuredClone(view)
  }
  prepareSelection(ownerId: number, input: { confirmationId: string; content: string; category: R1Memory['category'] }): MemoryConfirmation {
    const record = this.record(ownerId, input.confirmationId)
    record.context.assertCurrent()
    if (!record.view.requiresSelection || typeof input.content !== 'string' || !input.content.trim() ||
      !record.context.source.body.includes(input.content.trim())) throw new Error('MEMORY_SELECTION_NOT_FROM_SOURCE')
    new R1MemoryStore(this.db).validateCandidate({ content: input.content, category: input.category, expiresAt: null })
    this.pending.delete(input.confirmationId)
    return this.offer({ operation: 'remember', content: input.content.trim(), category: input.category, validUntil: null }, record.context)
  }
  offer(candidate: MemorySaveCandidate, context: Context): MemoryConfirmation {
    context.assertCurrent()
    new R1MemoryStore(this.db).validateCandidate({ content: candidate.content, category: candidate.category, expiresAt: candidate.validUntil })
    if (!Number.isInteger(context.ownerId) || context.ownerId < 1 || context.source.role !== 'user') throw new Error('MEMORY_CONFIRMATION_OWNER_INVALID')
    if (context.temporary && candidate.operation !== 'remember') throw new Error('MEMORY_UNAVAILABLE_IN_TEMPORARY_SESSION')
    if (context.temporary && !this.exitTemporary) throw new Error('MEMORY_TEMPORARY_EXIT_UNAVAILABLE')
    const fingerprint = createHash('sha256').update(JSON.stringify({ candidate, source: context.source.messageId, temporary: context.temporary })).digest('hex')
    this.prune()
    if (this.cancelledSources.has(`${context.ownerId}:${context.source.messageId}`)) throw new Error('MEMORY_CONFIRMATION_CANCELLED')
    for (const record of this.pending.values()) if (record.context.ownerId === context.ownerId && record.fingerprint === fingerprint) return structuredClone(record.view)
    this.revoke(context.ownerId)
    const view: MemoryConfirmation = { confirmationId: randomUUID(), operation: candidate.operation, content: candidate.content,
      category: candidate.category, validUntil: candidate.validUntil, temporary: context.temporary, sensitive: context.sensitive,
      expiresAt: new Date(this.now() + 300_000).toISOString() }
    this.pending.set(view.confirmationId, { view, candidate: structuredClone(candidate), context: { ...context, source: structuredClone(context.source) }, fingerprint })
    this.options.notify(context.ownerId, structuredClone(view))
    return structuredClone(view)
  }
  private record(ownerId: number, id: string): Pending {
    const record = this.pending.get(id)
    if (!record || record.context.ownerId !== ownerId) throw new Error('MEMORY_CONFIRMATION_NOT_FOUND')
    if (Date.parse(record.view.expiresAt) <= this.now()) { this.pending.delete(id); this.options.notify(ownerId, null); throw new Error('MEMORY_CONFIRMATION_EXPIRED') }
    return record
  }
  cancel(ownerId: number, id: string): void {
    if (this.completed.get(id)?.ownerId === ownerId) throw new Error('MEMORY_CONFIRMATION_ALREADY_COMMITTED')
    const record = this.record(ownerId, id)
    this.cancelledSources.set(`${ownerId}:${record.context.source.messageId}`, Date.parse(record.view.expiresAt))
    this.pending.delete(id); this.options.notify(ownerId, null)
  }
  commit(ownerId: number, id: string): ConfirmedMemory {
    const completed = this.completed.get(id)
    if (completed && completed.ownerId === ownerId) {
      if (completed.expiresAt <= this.now()) { this.completed.delete(id); throw new Error('MEMORY_CONFIRMATION_EXPIRED') }
      return structuredClone(completed.result)
    }
    const record = this.record(ownerId, id)
    if (record.view.requiresSelection) throw new Error('MEMORY_SELECTION_REQUIRED')
    try { record.context.assertCurrent() } catch { this.pending.delete(id); this.options.notify(ownerId, null); throw new Error('MEMORY_CONFIRMATION_STALE') }
    const { candidate, context } = record
    if (context.temporary && !this.exitTemporary) throw new Error('MEMORY_TEMPORARY_EXIT_UNAVAILABLE')
    const result = inTransaction(this.db, () => {
      context.assertCurrent()
      if (!context.temporary) {
        const source = this.db.prepare(`SELECT m.body, m.session_id FROM messages m JOIN sessions s ON s.session_id = m.session_id
          WHERE m.message_id = ? AND m.role = 'user' AND s.temporary = 0 AND s.status <> 'memory_source'`).get(context.source.messageId) as { body: string; session_id: string } | undefined
        if (!source || source.body !== context.source.body || source.session_id !== context.source.sessionId) throw new Error('MEMORY_SOURCE_NOT_AVAILABLE')
      }
      const store = new R1MemoryStore(this.db)
      const memory = context.temporary ? store.addManual({ content: candidate.content, category: candidate.category, expiresAt: candidate.validUntil }) :
        candidate.operation === 'remember' ? store.remember({ content: candidate.content, category: candidate.category,
          sourceMessageIds: [context.source.messageId], expiresAt: candidate.validUntil }) :
          store.update({ memoryId: candidate.memoryId!, expectedVersion: candidate.expectedVersion!, content: candidate.content,
            category: candidate.category, sourceMessageIds: [context.source.messageId], expiresAt: candidate.validUntil })
      const nextSessionId = context.temporary ? new R1Conversations(this.db).start(false) : null
      const committed: ConfirmedMemory = { memory, temporary: false, sessionChanged: context.temporary }
      afterTransactionCommit(this.db, () => {
        // Idempotency retains the committed DTO, never the original temporary body or context closure.
        this.completed.set(id, { ownerId, result: committed, expiresAt: Date.parse(record.view.expiresAt) })
        this.pending.delete(id)
        if (nextSessionId) { try { this.exitTemporary!(nextSessionId) } finally { this.options.onTemporaryExited() } }
        if (candidate.operation === 'update') this.options.onInvalidated(memory.deletionEpoch)
        this.options.notify(ownerId, null)
      })
      return committed
    })
    return structuredClone(result)
  }
  private prune(): void {
    for (const [id, record] of this.pending) if (Date.parse(record.view.expiresAt) <= this.now()) this.pending.delete(id)
    for (const [id, record] of this.completed) if (record.expiresAt <= this.now()) this.completed.delete(id)
    for (const [key, expiry] of this.cancelledSources) if (expiry <= this.now()) this.cancelledSources.delete(key)
  }
}
