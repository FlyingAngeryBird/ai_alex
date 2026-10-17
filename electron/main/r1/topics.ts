import { createHash, randomUUID } from 'node:crypto'
import { inTransaction, type R1Database } from './database.js'
import { R1MemoryStore } from './memory.js'
import { invalidateMemoryContext, memoryContextCutoff } from './memoryContext.js'
import { R1MemoryPolicy } from './memoryPolicy.js'
import { rankMemoryCandidates } from './memoryRetrieval.js'
import type { SessionMessage } from './conversations.js'

export type R1Topic = { topicId: string; title: string; summary: string; unresolved: string[]; sourceRefs: string[];
  status: 'active' | 'resolved'; version: number; deletionEpoch: number; updatedAt: string }
export type TopicSource = { messageId: string; sessionId: string; turnId: string; role: string; body: string; createdAt: string }
export type TopicDraft = { topicId: string | null; expectedVersion: number | null; title: string; unresolved: string[]; status: R1Topic['status'] }
export type ContextSummary = { summary: string; sourceTurnIds: string[]; memoryIds: string[]; taskFacts: unknown[]; topic?: TopicDraft | null }
type Row = { topic_id: string; title: string; summary: string; unresolved_json: string; source_refs_json: string;
  status: R1Topic['status']; version: number; deletion_epoch: number; updated_at: string; deleted_at: string | null }
const view = (r: Row): R1Topic => ({ topicId: r.topic_id, title: r.title, summary: r.summary, unresolved: JSON.parse(r.unresolved_json),
  sourceRefs: JSON.parse(r.source_refs_json), status: r.status, version: r.version, deletionEpoch: r.deletion_epoch, updatedAt: r.updated_at })
const digest = (body: string) => createHash('sha256').update(body).digest('hex')
export class R1Topics {
  constructor(private readonly db: R1Database) {}
  private suppressed(topic: R1Topic): boolean {
    return [topic.topicId, ...topic.sourceRefs].some(ref => Boolean(this.db.prepare('SELECT 1 FROM source_suppression WHERE source_ref = ?').get(ref)))
  }
  get(topicId: string): R1Topic {
    if (typeof topicId !== 'string' || !topicId) throw new Error('INVALID_TOPIC_ID')
    const row = this.db.prepare('SELECT * FROM topics WHERE topic_id = ? AND deleted_at IS NULL').get(topicId) as Row | undefined
    if (!row) throw new Error('TOPIC_NOT_FOUND')
    const result = view(row)
    if (this.suppressed(result)) throw new Error('TOPIC_NOT_FOUND')
    return result
  }
  list(input: { query?: string; page?: number } = {}) {
    const query = input.query ?? '', page = input.page ?? 0
    if (typeof query !== 'string' || [...query].length > 1000 || !Number.isInteger(page) || page < 0) throw new Error('INVALID_TOPIC_QUERY')
    const pattern = `%${query.trim().replace(/[\\%_]/g, '\\$&')}%`
    const rows = this.db.prepare(`SELECT * FROM topics WHERE deleted_at IS NULL AND
      (title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\') ORDER BY updated_at DESC, topic_id`).all(pattern, pattern) as Row[]
    const current = rows.map(view).filter(topic => !this.suppressed(topic))
    return { entries: current.slice(page * 20, page * 20 + 20), page, hasMore: current.length > page * 20 + 20 }
  }
  recall(query: string, policy: { limit: number; assertBudget(): void }): R1Topic[] {
    if (typeof query !== 'string' || [...query].length > 1000) throw new Error('INVALID_TOPIC_QUERY')
    policy.assertBudget()
    const rows = this.db.prepare('SELECT * FROM topics WHERE deleted_at IS NULL ORDER BY updated_at DESC,topic_id').all() as Row[]
    const current = rows.map(view).filter((topic, index) => { if (index % 64 === 0) policy.assertBudget(); return !this.suppressed(topic) })
      .map(topic => ({ topic, content: [topic.title, topic.summary, ...topic.unresolved].join('\n') }))
    return rankMemoryCandidates(current, query, policy).map(value => value.topic)
  }
  private validate(input: Pick<R1Topic, 'title' | 'summary' | 'unresolved' | 'status'>): void {
    if (typeof input.title !== 'string' || !input.title.trim() || [...input.title].length > 80 ||
      typeof input.summary !== 'string' || !input.summary.trim() || [...input.summary].length > 1600 ||
      !Array.isArray(input.unresolved) || input.unresolved.length > 50 || input.unresolved.some(value => typeof value !== 'string' || !value.trim() || [...value].length > 500) ||
      !['active', 'resolved'].includes(input.status) || (input.status === 'resolved' && input.unresolved.length)) throw new Error('INVALID_TOPIC_CONTENT')
  }
  private write(topic: R1Topic, origin: 'summary' | 'user', authorizationVersion: number | null = null): R1Topic {
    this.db.prepare(`INSERT INTO topics (topic_id, title, summary, unresolved_json, source_refs_json, status, version, deletion_epoch, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(topic_id) DO UPDATE SET title=excluded.title, summary=excluded.summary,
      unresolved_json=excluded.unresolved_json, source_refs_json=excluded.source_refs_json, status=excluded.status,
      version=excluded.version, deletion_epoch=excluded.deletion_epoch, updated_at=excluded.updated_at`).run(topic.topicId, topic.title, topic.summary,
        JSON.stringify(topic.unresolved), JSON.stringify(topic.sourceRefs), topic.status, topic.version, topic.deletionEpoch, topic.updatedAt)
    this.db.prepare('INSERT INTO topic_versions (topic_id, version, snapshot_json, origin, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(topic.topicId, topic.version, JSON.stringify(topic), origin, topic.updatedAt)
    this.db.prepare('INSERT INTO event_log (event_id, occurred_at, kind, owner_id, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), topic.updatedAt, 'topic_saved', topic.topicId, JSON.stringify({ version: topic.version, origin, authorizationVersion, sourceCount: topic.sourceRefs.length }))
    return this.get(topic.topicId)
  }
  commitSummary(input: { result: ContextSummary; sources: SessionMessage[]; existingTopics: R1Topic[];
    authorizationVersion: number; deletionEpoch: number; assertCurrent(): void }): R1Topic | null {
    const { result } = input
    if (!result.topic) return null
    this.validate({ ...result.topic, summary: result.summary })
    if (!result.sourceTurnIds.length || result.memoryIds.length || result.taskFacts.length) throw new Error('TOPIC_REFERENCES_INVALID')
    const selected = input.sources.filter(source => result.sourceTurnIds.includes(source.turnId))
    if (result.sourceTurnIds.some(id => !selected.some(source => source.turnId === id)) || !selected.some(source => source.role === 'user')) throw new Error('TOPIC_REFERENCES_INVALID')
    return inTransaction(this.db, () => {
      input.assertCurrent(); new R1MemoryPolicy(this.db).assertAuthorized(input.authorizationVersion)
      if (new R1MemoryStore(this.db).currentDeletionEpoch() !== input.deletionEpoch) throw new Error('TOPIC_CONTEXT_REVOKED')
      for (const source of selected) this.assertSource(source)
      let previous: R1Topic | null = null
      if (result.topic!.topicId !== null) {
        const provided = input.existingTopics.find(topic => topic.topicId === result.topic!.topicId && topic.version === result.topic!.expectedVersion)
        if (!provided) throw new Error('TOPIC_TARGET_NOT_PROVIDED')
        previous = this.get(provided.topicId)
        if (previous.version !== provided.version) throw new Error('VERSION_CONFLICT')
      } else if (result.topic!.expectedVersion !== null) throw new Error('TOPIC_TARGET_NOT_PROVIDED')
      const refs = [...new Set([...(previous?.sourceRefs ?? []), ...selected.map(source => source.messageId)])]
      if (refs.length > 500) throw new Error('TOPIC_SOURCE_LIMIT')
      const epoch = previous ? input.deletionEpoch + 1 : input.deletionEpoch
      if (previous) invalidateMemoryContext(this.db, epoch)
      return this.write({ topicId: previous?.topicId ?? randomUUID(), title: result.topic!.title.trim(), summary: result.summary.trim(),
        unresolved: result.topic!.unresolved.map(text => text.trim()), status: result.topic!.status, sourceRefs: refs,
        version: (previous?.version ?? 0) + 1, deletionEpoch: epoch, updatedAt: new Date().toISOString() }, 'summary', input.authorizationVersion)
    })
  }
  validateSources(sources: SessionMessage[]): void { for (const source of sources) this.assertSource(source) }
  private assertSource(source: SessionMessage): void {
    const row = this.db.prepare(`SELECT m.rowid AS sequence, m.*, s.temporary FROM messages m JOIN sessions s ON s.session_id=m.session_id
      WHERE m.message_id=? AND s.status <> 'memory_source'`).get(source.messageId) as { sequence: number; body: string; session_id: string; turn_id: string;
        role: string; status: string; temporary: number; played_until_ms: number | null } | undefined
    if (!row || !['user', 'assistant'].includes(row.role) || row.role === 'user' && row.status !== 'final' || row.temporary || row.sequence <= memoryContextCutoff(this.db) || row.session_id !== source.sessionId || row.turn_id !== source.turnId ||
      row.role !== source.role || digest(row.body) !== digest(source.body) || row.status !== source.status ||
      (row.role === 'assistant' && (row.status === 'interrupted' || row.played_until_ms !== null && row.status !== 'heard')) ||
      this.db.prepare('SELECT 1 FROM source_suppression WHERE source_ref IN (?, ?)').get(source.messageId, source.turnId)) throw new Error('TOPIC_SOURCE_REVOKED')
  }
  versions(topicId: string): Array<R1Topic & { origin: string }> {
    this.get(topicId)
    return (this.db.prepare('SELECT snapshot_json, origin FROM topic_versions WHERE topic_id=? ORDER BY version DESC').all(topicId) as { snapshot_json: string; origin: string }[])
      .map(row => ({ ...JSON.parse(row.snapshot_json) as R1Topic, origin: row.origin }))
  }
  sources(topicId: string): TopicSource[] {
    return this.get(topicId).sourceRefs.map(ref => {
      const row = this.db.prepare(`SELECT m.* FROM messages m JOIN sessions s ON s.session_id=m.session_id
        WHERE m.message_id=? AND s.temporary=0`).get(ref) as { message_id: string; session_id: string; turn_id: string; role: string; body: string; created_at: string } | undefined
      if (!row) throw new Error('TOPIC_SOURCE_UNAVAILABLE')
      return { messageId: row.message_id, sessionId: row.session_id, turnId: row.turn_id, role: row.role, body: row.body, createdAt: row.created_at }
    })
  }
  related(topicId: string) {
    const sources = this.sources(topicId), turnIds = new Set(sources.map(source => source.turnId))
    const artifacts = (this.db.prepare('SELECT a.artifact_id, a.source_turn_id, a.current_version, v.metadata_json FROM artifacts a JOIN artifact_versions v ON v.artifact_id=a.artifact_id AND v.version=a.current_version').all() as { artifact_id: string; source_turn_id: string; current_version: number; metadata_json: string }[])
      .filter(row => turnIds.has(row.source_turn_id) && !this.db.prepare('SELECT 1 FROM source_suppression WHERE source_ref=?').get(row.artifact_id))
      .map(row => ({ artifactId: row.artifact_id, version: row.current_version, title: String(JSON.parse(row.metadata_json).title) }))
    return { sessionIds: [...new Set(sources.filter(source => !this.db.prepare("SELECT 1 FROM sessions WHERE session_id=? AND status='memory_source'").get(source.sessionId)).map(source => source.sessionId))], artifacts }
  }
  update(input: { topicId: string; expectedVersion: number; title: string; summary: string; unresolved: string[]; status: R1Topic['status'] }): R1Topic {
    this.validate(input)
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('INVALID_TOPIC_VERSION')
    const body = `话题：${input.title.trim()}\n结论：${input.summary.trim()}\n未解问题：${input.unresolved.length ? input.unresolved.join('；') : '暂无'}\n状态：${input.status === 'active' ? '进行中' : '已形成结论'}`
    if ([...body].length > 8000) throw new Error('TOPIC_SOURCE_LIMIT')
    return inTransaction(this.db, () => {
      const old = this.get(input.topicId)
      if (old.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
      if (old.sourceRefs.length >= 500) throw new Error('TOPIC_SOURCE_LIMIT')
      const now = new Date().toISOString(), sessionId = randomUUID(), messageId = randomUUID(), epoch = new R1MemoryStore(this.db).currentDeletionEpoch() + 1
      this.db.prepare("INSERT INTO sessions VALUES (?, 0, 'memory_source', ?, ?)").run(sessionId, now, now)
      this.db.prepare("INSERT INTO messages (message_id, session_id, turn_id, role, body, status, created_at) VALUES (?, ?, ?, 'user', ?, 'final', ?)").run(messageId, sessionId, randomUUID(), body, now)
      invalidateMemoryContext(this.db, epoch)
      return this.write({ ...old, title: input.title.trim(), summary: input.summary.trim(), unresolved: input.unresolved.map(value => value.trim()),
        status: input.status, version: old.version + 1, deletionEpoch: epoch, sourceRefs: [...old.sourceRefs, messageId], updatedAt: now }, 'user')
    })
  }
  forget(input: { topicId: string; expectedVersion: number }) {
    return inTransaction(this.db, () => {
      const old = this.get(input.topicId)
      if (old.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
      const now = new Date().toISOString(), epoch = new R1MemoryStore(this.db).currentDeletionEpoch() + 1
      this.db.prepare('UPDATE topics SET deleted_at=?, deletion_epoch=?, version=version+1, updated_at=? WHERE topic_id=?').run(now, epoch, now, old.topicId)
      this.db.prepare('INSERT INTO source_suppression VALUES (?, ?, ?) ON CONFLICT(source_ref) DO UPDATE SET deletion_epoch=excluded.deletion_epoch').run(old.topicId, epoch, now)
      invalidateMemoryContext(this.db, epoch)
      return { topicId: old.topicId, deletionEpoch: epoch }
    })
  }
}
export const topicContext = (topic: R1Topic) => ({ topicId: topic.topicId, version: topic.version, title: topic.title, summary: topic.summary,
  unresolved: topic.unresolved, status: topic.status, sourceRefs: topic.sourceRefs.slice(-50) })
