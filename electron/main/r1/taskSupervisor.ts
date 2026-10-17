import type { WebSource } from '../providers/pageReader.js'
import { createHash, randomUUID } from 'node:crypto'
import { inTransaction, type R1Database } from './database.js'
import type { R1TaskInput, R1TaskAuthority } from './taskBoundary.js'
import type { R1PromptAssets } from './promptAssets.js'
import { R1Items } from './items.js'
import { R1Artifacts, type ArtifactDraft } from './artifacts.js'
import { memoryContextCutoff } from './memoryContext.js'
import { assertArtifactRange, type ArtifactEditBinding } from './artifactContext.js'

export type TaskStatus = 'accepted' | 'running' | 'waiting_input' | 'paused' | 'needs_resume' |
  'succeeded' | 'partially_succeeded' | 'failed' | 'cancelled'
export type TaskSource = { messageId: string; sessionId: string; turnId: string; body: string;
  createdAt: string; timezone: string; temporary: boolean; selectedTrackKey?: string | null }
type PlanStep = { stepId: string; action: string; dependsOn: string[];
  status: 'pending' | 'running' | 'completed' | 'blocked' | 'cancelled'; successCondition: string }
type PendingUiAction = { actionId: string; alias: string; runId: string; goalVersion: number }
export type UiActionOutcome = { actionId: string; alias: string; outcome: 'executed' | 'cancelled' | 'expired' | 'superseded' | 'revoked' | 'failed'; detail: string; at: string }
type TaskCheckpoint = { version: 1; requestKey: string; requestFingerprint?: string; source: TaskSource; sourceRefs: string[];
  contextVersion: number; deletionEpoch: number; authorizedAliases: string[]; loadedSkillIds: string[];
  runId: string | null; stopRequested: 'paused' | 'cancelled' | null; planVersion: number; plan: PlanStep[];
  ownerId?: number; pendingUiActions?: PendingUiAction[]; uiActionOutcomes?: UiActionOutcome[];
  observations: R1TaskInput['observations']; receiptActionIds: string[]; progressBrief: string;
  actions?: Array<{ actionId: string; alias: string; runId: string; fingerprint?: string; callId?: string }>;
  toolReceipts?: TaskToolReceipt[];
  initialBudget?: R1TaskInput['budget']; budgetStopped?: boolean; persistenceConfirmed?: boolean;
  steerEventId?: string;
  artifactEdit?: ArtifactEditBinding | null;
  requiredActions?: Array<{ alias: string; minimumCount: number }>;
  result?: TaskResult; publicationRunId?: string }
export type TaskResult = { resultId: string; goalVersion: number; completionStatus: 'completed' | 'partial' | 'needs_input';
  replyBrief: string; sourceRefs: string[]; artifacts: Array<{ artifactId: string; version: number; title: string; content: string }>;
  unresolved: string[]; candidateRefs: string[];
  entityReceipts: Array<{ actionId: string; tool: string; status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    entityId: string | null; summary: string }> }
type TaskDraft = { status: TaskResult['completionStatus']; goalVersion: number; replyBrief: string; sourceRefs: string[];
  receiptActionIds: string[]; artifacts: ArtifactDraft[];
  candidates: Array<{ candidateId: string; label: string; summary: string; sourceRefs: string[] }>; unresolved: string[] }
export type TaskToolReceipt = { kind: 'receipt'; actionId: string; tool: string; status: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  entityId: string | null; entityVersion: number | null; data: Record<string, unknown>; errorCode: string | null; retryable: boolean; runId: string | null }
export type WebCandidate = { candidateId: string; label: string; sourceRefs: string[]; fields: Array<{ key: string; value: string | null; verification: 'verified' | 'unconfirmed' | 'conflicting'; sourceRefs: string[] }> }
export function candidateSaveActionId(taskId: string, candidateId: string): string {
  return `candidate-save:${createHash('sha256').update(`${taskId}:${candidateId}`).digest('hex')}`
}
export type R1Task = { webResult?: { sources: WebSource[]; candidates: WebCandidate[] }; taskId: string; goal: string; constraints: string[]; goalVersion: number;
  status: TaskStatus; assetReleaseId: string; planVersion: number; progressBrief: string;
  queuePosition: number | null; temporary: boolean; budget: R1TaskInput['budget']; runId: string | null;
  resultId: string | null; result: TaskResult | null }
type RecordTask = Omit<R1Task, 'queuePosition' | 'planVersion' | 'progressBrief' | 'runId' | 'result' | 'resultId'> & {
  checkpoint: TaskCheckpoint; createdAt: string }
export type TaskLease = Pick<R1TaskInput, 'taskId' | 'runId' | 'goalVersion' | 'contextVersion' | 'deletionEpoch'>
export type TaskEvent = { eventId: string; occurredAt: string; task: R1Task;
  reason: 'accepted' | 'running' | 'updated' | 'pause_requested' | 'paused' | 'cancelled' | 'needs_resume' | 'plan' | 'completed' | 'waiting_input' }
const requireText = (value: unknown, max: number, code: string): string => {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) throw new Error(code)
  return value
}

/** Owns identity, queue, budgets and safe checkpoints. Models cannot create run/action IDs. */
export class R1TaskSupervisor {
  private readonly records = new Map<string, RecordTask>()
  private readonly anchors = new Map<string, { startMs: number; remainingMs: number }>()
  private readonly listeners = new Set<(event: TaskEvent) => void>()
  private readonly controllers = new Map<string, AbortController>()
  private suspended = false
  private closed = false
  private pendingEvents: TaskEvent[] | null = null
  private pendingInvalidator?: (taskId: string, actionIds: string[], reason: string) => void
  private readonly musicOperations = new Map<string, { fingerprint: string; promise: Promise<TaskToolReceipt> }>()
  constructor(private readonly db: R1Database, private readonly assets: R1PromptAssets,
    private readonly deletionEpoch: () => number, private readonly options: {
      clock?: () => number; temporarySource?: (messageId: string) => TaskSource | undefined; artifacts?: R1Artifacts
    } = {}) {
    const rows = db.prepare('SELECT * FROM agent_tasks ORDER BY created_at, rowid').all() as {
      task_id: string; goal: string; constraints_json: string; goal_version: number; status: TaskStatus;
      asset_release_id: string; budget_json: string; checkpoint_json: string; created_at: string
    }[]
    for (const row of rows) {
      const checkpoint = JSON.parse(row.checkpoint_json) as TaskCheckpoint
      if (checkpoint.version !== 1) continue // Older unsupported records remain preserved, never executed.
      const record: RecordTask = { taskId: row.task_id, goal: row.goal, constraints: JSON.parse(row.constraints_json),
        goalVersion: row.goal_version, status: row.status, assetReleaseId: row.asset_release_id,
        budget: JSON.parse(row.budget_json), checkpoint, temporary: false, createdAt: row.created_at }
      // Confirmation tickets live only in the previous process; a restarted app
      // must not resurrect a pending delete/export.
      this.records.set(record.taskId, record)
      if (checkpoint.pendingUiActions?.length) { checkpoint.pendingUiActions = []; this.persist(record) }
      if (['accepted', 'running'].includes(record.status)) {
        record.status = 'needs_resume'; record.checkpoint.stopRequested = null
        record.checkpoint.progressBrief = '应用已重新启动，等待你继续。'
        this.endRun(record, 'needs_resume'); this.persist(record)
      }
    }
  }
  private clock(): number { return (this.options.clock ?? (() => performance.now()))() }
  private source(messageId: string): TaskSource {
    const temporary = this.options.temporarySource?.(messageId)
    if (temporary) return structuredClone(temporary)
    const row = this.db.prepare(`SELECT m.rowid AS sequence, m.message_id, m.session_id, m.turn_id, m.body, m.created_at
      FROM messages m JOIN sessions s ON s.session_id = m.session_id WHERE m.message_id = ?
      AND m.role = 'user' AND s.temporary = 0 AND s.status <> 'memory_source'`)
      .get(messageId) as { sequence: number; message_id: string; session_id: string; turn_id: string; body: string; created_at: string } | undefined
    if (!row) throw new Error('TASK_SOURCE_NOT_FOUND')
    if (row.sequence <= memoryContextCutoff(this.db) || this.db.prepare('SELECT 1 FROM source_suppression WHERE source_ref = ?').get(messageId)) throw new Error('TASK_SOURCE_SUPPRESSED')
    return { messageId: row.message_id, sessionId: row.session_id, turnId: row.turn_id,
      body: row.body, createdAt: row.created_at, timezone: '', temporary: false }
  }
  private persist(record: RecordTask): void {
    if (record.temporary) return
    this.db.prepare(`INSERT INTO agent_tasks
      (task_id, session_id, goal, constraints_json, goal_version, asset_release_id, status, budget_json,
       checkpoint_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET goal = excluded.goal, constraints_json = excluded.constraints_json,
      goal_version = excluded.goal_version, status = excluded.status, budget_json = excluded.budget_json,
      checkpoint_json = excluded.checkpoint_json, updated_at = excluded.updated_at`)
      .run(record.taskId, record.checkpoint.source.sessionId, record.goal, JSON.stringify(record.constraints), record.goalVersion,
        record.assetReleaseId, record.status, JSON.stringify(record.budget), JSON.stringify(record.checkpoint), record.createdAt, new Date().toISOString())
  }
  private checked(taskId: string, version?: number): RecordTask {
    if (this.closed) throw new Error('TASK_SERVICE_CLOSED')
    const record = this.records.get(taskId)
    if (!record) throw new Error('TASK_NOT_FOUND')
    if (version !== undefined && record.goalVersion !== version) throw new Error('VERSION_CONFLICT')
    return record
  }
  private account(record: RecordTask): void {
    const anchor = this.anchors.get(record.taskId)
    if (anchor) record.budget.activeMsRemaining = Math.max(0,
      Math.floor(anchor.remainingMs - Math.max(0, this.clock() - anchor.startMs)))
  }
  get(taskId: string): R1Task {
    const record = this.checked(taskId); this.account(record)
    const queued = [...this.records.values()].filter(value => value.status === 'accepted')
    const position = queued.findIndex(value => value.taskId === taskId)
    const result = record.checkpoint.deletionEpoch === this.deletionEpoch() ? record.checkpoint.result ?? null : null
    const running = [...this.records.values()].some(value => value.status === 'running')
    return structuredClone({ taskId, goal: record.goal, constraints: record.constraints, goalVersion: record.goalVersion,
      status: record.status, assetReleaseId: record.assetReleaseId, planVersion: record.checkpoint.planVersion,
      progressBrief: record.checkpoint.progressBrief, temporary: record.temporary,
      queuePosition: position >= 0 ? position + (running ? 1 : 0) : null, budget: record.budget, runId: record.checkpoint.runId,
      resultId: result?.resultId ?? null, result,
      webResult: record.checkpoint.deletionEpoch === this.deletionEpoch() ? this.webResult(record) : { sources: [], candidates: [] } })
  }
  private webResult(record: RecordTask): { sources: WebSource[]; candidates: WebCandidate[] } {
    const sources = new Map<string, WebSource>(), candidates = new Map<string, WebCandidate>()
    for (const receipt of record.checkpoint.toolReceipts ?? []) {
      if (receipt.status !== 'succeeded') continue
      if (receipt.tool === 'web.search') {
        for (const source of receipt.data.sources as WebSource[]) if (!sources.has(source.sourceRef)) sources.set(source.sourceRef, source)
        for (const candidate of receipt.data.candidates as WebCandidate[]) candidates.set(candidate.candidateId, candidate)
      } else if (receipt.tool === 'web.readPage') {
        const source = receipt.data.source as WebSource
        sources.set(source.sourceRef, source)
      }
    }
    return { sources: [...sources.values()], candidates: [...candidates.values()] }
  }
  candidateVersion(taskId: string, candidateId: string): number {
    if (!this.contextIsCurrent(taskId)) throw new Error('TASK_CONTEXT_STALE')
    const observation = this.checked(taskId).checkpoint.observations.find(item => item.refId === candidateId && item.kind === 'candidate')
    if (!observation) throw new Error('TASK_CANDIDATE_NOT_FOUND')
    return observation.version ?? 1
  }
  saveCandidate(input: { taskId: string; expectedGoalVersion: number; candidateId: string; title: string; temporarySaveConfirmed?: boolean }) {
    const record = this.checked(input.taskId)
    if (record.goalVersion !== input.expectedGoalVersion) throw new Error('VERSION_CONFLICT')
    if (!this.contextIsCurrent(input.taskId)) throw new Error('TASK_CONTEXT_STALE')
    if (record.temporary && !input.temporarySaveConfirmed) throw new Error('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
    requireText(input.title, 80, 'CANDIDATE_TITLE_INVALID')
    const web = this.webResult(record), candidate = web.candidates.find(item => item.candidateId === input.candidateId)
    if (!candidate) throw new Error('TASK_CANDIDATE_NOT_FOUND')
    const actionId = candidateSaveActionId(input.taskId, input.candidateId)
    const items = new R1Items(this.db)
    const prior = this.db.prepare('SELECT entity_id FROM receipts WHERE action_id = ? AND status = ?').get(actionId, 'succeeded') as { entity_id: string } | undefined
    if (prior) {
      const item = items.toolView(prior.entity_id)
      return { itemId: item.itemId, title: item.title, version: item.version }
    }
    const sources = web.sources.filter(source => candidate.sourceRefs.includes(source.sourceRef))
    if (!sources.length) throw new Error('TASK_CANDIDATE_SOURCE_MISSING')
    const body = sources.map(source => `${source.title}
${source.snippet}

来源：${source.url}
访问时间：${source.accessedAt}
页面日期：${source.publishedAt ?? '未提供'}
读取范围：${source.readStatus === 'read' ? '已读取页面' : source.readStatus === 'partial' ? '部分页面' : '仅搜索摘要'}`).join('\n\n')
    const saved = items.create({ actionId, kind: 'note', title: input.title, body, sourceRefs: candidate.sourceRefs })
    return { itemId: saved.item.itemId, title: saved.item.title, version: saved.item.version }
  }
  assertPageSource(lease: TaskLease, sourceRef: string, url: string): void {
    this.assertLease(lease)
    const source = this.webResult(this.checked(lease.taskId)).sources.find(item => item.sourceRef === sourceRef)
    // A fragment selects a section of the same resource; it must never allow
    // changing the host, path or query bound to the candidate.
    if (!source || source.url.split('#')[0] !== url.split('#')[0]) throw new Error('TASK_PAGE_SOURCE_INVALID')
  }
  list(temporarySessionId: string | null = null): R1Task[] {
    return [...this.records.values()].filter(record => temporarySessionId
      ? record.temporary && record.checkpoint.source.sessionId === temporarySessionId : !record.temporary)
      .map(record => this.get(record.taskId))
  }
  contextIsCurrent(taskId: string): boolean {
    const record = this.checked(taskId)
    return record.checkpoint.deletionEpoch === this.deletionEpoch() && !record.checkpoint.sourceRefs.some(ref =>
      Boolean(this.db.prepare('SELECT 1 FROM source_suppression WHERE source_ref = ?').get(ref)))
  }
  modelView(taskId: string): R1Task {
    const task = this.get(taskId)
    return this.contextIsCurrent(taskId) ? task : { ...task, goal: '任务上下文已变化，需要重新提供条件。', constraints: [],
      progressBrief: '需要核对当前条件。', result: null, resultId: null, webResult: { sources: [], candidates: [] } }
  }
  onChanged(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener) }
  }
  private emit(record: RecordTask, reason: TaskEvent['reason']): void {
    const event: TaskEvent = { eventId: randomUUID(), occurredAt: new Date().toISOString(), task: this.get(record.taskId), reason }
    if (this.pendingEvents) { this.pendingEvents.push(event); return }
    for (const listener of this.listeners) { try { listener(structuredClone(event)) } catch { /* committed */ } }
  }
  accept(input: { requestKey: string; sourceMessageId: string; timezone: string; goal: string;
    constraints: string[]; authorizedAliases: string[]; complexity: 'light' | 'complex'; persistenceConfirmed?: boolean; selectedTrackKey?: string | null;
    ownerId?: number; requiredActions?: Array<{ alias: string; minimumCount: number }>; artifactEdit?: ArtifactEditBinding | null }): R1Task {
    if (this.closed) throw new Error('TASK_SERVICE_CLOSED')
    if (input.selectedTrackKey !== undefined && input.selectedTrackKey !== null) requireText(input.selectedTrackKey, 160, 'TASK_TRACK_INVALID')
    requireText(input.requestKey, 160, 'TASK_REQUEST_KEY_INVALID')
    requireText(input.sourceMessageId, 160, 'TASK_SOURCE_INVALID')
    requireText(input.goal, 2000, 'TASK_GOAL_INVALID')
    if (!Array.isArray(input.constraints) || input.constraints.length > 50) throw new Error('TASK_CONSTRAINT_INVALID')
    input.constraints.forEach(value => requireText(value, 500, 'TASK_CONSTRAINT_INVALID'))
    if (!['light', 'complex'].includes(input.complexity)) throw new Error('TASK_COMPLEXITY_INVALID')
    if (input.ownerId !== undefined && (!Number.isSafeInteger(input.ownerId) || input.ownerId < 0)) throw new Error('TASK_OWNER_INVALID')
    if (typeof input.timezone !== 'string' || !input.timezone) throw new Error('TASK_TIMEZONE_INVALID')
    try { new Intl.DateTimeFormat('zh-CN', { timeZone: input.timezone }) } catch { throw new Error('TASK_TIMEZONE_INVALID') }
    this.assets.exposeTools({ channel: 'task', loadedSkillIds: [], authorizedAliases: input.authorizedAliases, temporary: false })
    const requirements = input.requiredActions ?? []
    if (!Array.isArray(requirements) || requirements.length > 20 || new Set(requirements.map(action => action.alias)).size !== requirements.length ||
      requirements.some(action => !input.authorizedAliases.includes(action.alias) || !Number.isSafeInteger(action.minimumCount) ||
        action.minimumCount < 1 || action.minimumCount > 50 || !['write', 'media', 'ui_then_write'].includes(this.assets.toolDefinition(action.alias).effect))) throw new Error('TASK_REQUIREMENTS_INVALID')
    // The original request remains immutable even when the current goal/source changes.
    const fingerprint = createHash('sha256').update(JSON.stringify({ sourceMessageId: input.sourceMessageId,
      timezone: input.timezone, goal: input.goal, constraints: input.constraints,
      ...(input.selectedTrackKey !== undefined ? { selectedTrackKey: input.selectedTrackKey } : {}),
      ...(input.artifactEdit ? { artifactEdit: input.artifactEdit } : {}),
      authorizedAliases: [...new Set(input.authorizedAliases)].sort(), complexity: input.complexity,
      ...(requirements.length ? { requiredActions: [...requirements].sort((left, right) => left.alias.localeCompare(right.alias)) } : {}),
      ...(input.persistenceConfirmed === true ? { persistenceConfirmed: true } : {}) })).digest('hex')
    const existing = [...this.records.values()].find(record => record.checkpoint.requestKey === input.requestKey)
    if (existing) {
      if (!existing.checkpoint.requestFingerprint) throw new Error('TASK_REQUEST_REVALIDATION_REQUIRED')
      if (existing.checkpoint.requestFingerprint !== fingerprint) throw new Error('TASK_REQUEST_KEY_REUSED')
      return this.get(existing.taskId)
    }
    const source = this.source(input.sourceMessageId)
    source.timezone = input.timezone
    source.selectedTrackKey = input.selectedTrackKey ?? null
    this.assertArtifactBinding(input.artifactEdit, source)
    this.assets.exposeTools({ channel: 'task', loadedSkillIds: [], authorizedAliases: input.authorizedAliases, temporary: source.temporary })
    if ([...this.records.values()].filter(record => ['accepted', 'running'].includes(record.status)).length >= 4) throw new Error('TASK_QUEUE_FULL')
    const taskId = randomUUID()
    const record: RecordTask = { taskId, goal: input.goal, constraints: [...input.constraints],
      goalVersion: 1, status: 'accepted', assetReleaseId: this.assets.releaseId, temporary: source.temporary,
      createdAt: new Date().toISOString(), budget: this.assets.taskBudget(input.complexity),
      checkpoint: { version: 1, requestKey: input.requestKey, requestFingerprint: fingerprint, source, sourceRefs: [source.messageId],
        contextVersion: 1, deletionEpoch: this.deletionEpoch(), authorizedAliases: [...input.authorizedAliases], loadedSkillIds: [],
        initialBudget: this.assets.taskBudget(input.complexity), persistenceConfirmed: input.persistenceConfirmed === true,
        ownerId: input.ownerId ?? 0, pendingUiActions: [],
        requiredActions: structuredClone(requirements), artifactEdit: structuredClone(input.artifactEdit ?? null),
        runId: null, stopRequested: null, planVersion: 0, plan: [], observations: [{ refId: source.messageId,
          kind: 'source', version: 1, summary: JSON.stringify({ turnId: source.turnId, createdAt: source.createdAt, timezone: source.timezone,
            requiredActions: requirements }),
          resourcePath: `/task/${taskId}/source-turn.json` }], receiptActionIds: [], progressBrief: '已受理。' } }
    this.attachArtifactObservation(record)
    this.persist(record); this.records.set(record.taskId, record); this.emit(record, 'accepted')
    return this.get(record.taskId)
  }
  claimNext(): { lease: TaskLease; signal: AbortSignal } | null {
    if (this.closed || this.suspended || [...this.records.values()].some(record => record.status === 'running')) return null
    const record = [...this.records.values()].find(record => record.status === 'accepted')
    if (!record) return null
    if (record.assetReleaseId !== this.assets.releaseId) throw new Error('TASK_ASSET_RELEASE_UNAVAILABLE')
    const runId = randomUUID(); record.checkpoint.runId = runId
    record.checkpoint.stopRequested = null; record.status = 'running'; record.checkpoint.progressBrief = '正在处理。'
    inTransaction(this.db, () => {
      this.persist(record)
      if (!record.temporary) this.db.prepare('INSERT INTO task_runs (run_id, task_id, goal_version, status, started_at) VALUES (?, ?, ?, ?, ?)')
        .run(runId, record.taskId, record.goalVersion, 'running', new Date().toISOString())
    })
    this.anchors.set(record.taskId, { startMs: this.clock(), remainingMs: record.budget.activeMsRemaining })
    const controller = new AbortController(); this.controllers.set(runId, controller)
    this.emit(record, 'running')
    return { lease: this.lease(record), signal: controller.signal }
  }
  hasRunnable(): boolean {
    return !this.closed && !this.suspended && ![...this.records.values()].some(record => record.status === 'running') &&
      [...this.records.values()].some(record => record.status === 'accepted')
  }
  private lease(record: RecordTask): TaskLease {
    if (!record.checkpoint.runId) throw new Error('TASK_RUN_MISSING')
    return { taskId: record.taskId, runId: record.checkpoint.runId, goalVersion: record.goalVersion,
      contextVersion: record.checkpoint.contextVersion, deletionEpoch: record.checkpoint.deletionEpoch }
  }
  assertLease(lease: TaskLease): void {
    const record = this.checked(lease.taskId); this.account(record)
    if (record.status !== 'running' || record.checkpoint.stopRequested) throw new Error('TASK_NOT_RUNNING')
    if (record.checkpoint.runId !== lease.runId || record.goalVersion !== lease.goalVersion ||
      record.checkpoint.contextVersion !== lease.contextVersion || record.checkpoint.deletionEpoch !== lease.deletionEpoch ||
      this.deletionEpoch() !== lease.deletionEpoch) throw new Error('TASK_CONTEXT_STALE')
    if (record.budget.activeMsRemaining <= 0) throw new Error('TASK_BUDGET_EXHAUSTED')
    this.assertArtifactBinding(record.checkpoint.artifactEdit, record.checkpoint.source)
  }
  private assertArtifactBinding(binding: ArtifactEditBinding | null | undefined, source: TaskSource): void {
    if (!binding) return
    const current = (this.options.artifacts ?? new R1Artifacts(this.db)).get(binding.artifact.artifactId, source.temporary ? source.sessionId : null)
    if (current.version !== binding.artifact.version || current.content !== binding.artifact.content || current.title !== binding.artifact.title ||
      JSON.stringify(current.sourceRefs) !== JSON.stringify(binding.artifact.sourceRefs)) throw new Error('VERSION_CONFLICT')
    if (new Set([source.messageId, current.artifactId, ...current.sourceRefs]).size > 50) throw new Error('TASK_OBSERVATION_LIMIT')
    if (binding.target) assertArtifactRange(current.content, binding.target)
  }
  private attachArtifactObservation(record: RecordTask): void {
    const edit = record.checkpoint.artifactEdit
    if (!edit) return
    record.checkpoint.sourceRefs = [...new Set([...record.checkpoint.sourceRefs, edit.artifact.artifactId, ...edit.artifact.sourceRefs])]
    if (record.checkpoint.sourceRefs.length > 50) throw new Error('TASK_OBSERVATION_LIMIT')
    record.checkpoint.observations.push({ refId: edit.artifact.artifactId, kind: 'artifact', version: edit.artifact.version,
      summary: JSON.stringify({ title: edit.artifact.title, target: edit.target }), resourcePath: `/task/${record.taskId}/current-artifact.json` })
  }
  artifactInput(lease: TaskLease): ArtifactEditBinding {
    this.assertLease(lease)
    const edit = this.checked(lease.taskId).checkpoint.artifactEdit
    if (!edit) throw new Error('TASK_ARTIFACT_NOT_AVAILABLE')
    return structuredClone(edit)
  }
  authority(taskId: string): R1TaskAuthority {
    const record = this.checked(taskId); this.account(record)
    return { ...this.lease(record), status: record.checkpoint.stopRequested ? 'paused' : record.status === 'running' ? 'running'
      : record.status === 'cancelled' ? 'cancelled' : record.status === 'paused' ? 'paused' : 'needs_resume',
      temporary: record.temporary, authorizedAliases: [...record.checkpoint.authorizedAliases],
      activeMsRemaining: record.budget.activeMsRemaining }
  }
  beginDecision(lease: TaskLease): R1TaskInput {
    this.assertLease(lease)
    const record = this.checked(lease.taskId)
    this.adoptExternalReceipts(record)
    const evidence = this.webResult(record)
    record.checkpoint.progressBrief = evidence.candidates.length
      ? `已取得 ${evidence.candidates.length} 个候选，正在核对并整理结果。`
      : record.checkpoint.receiptActionIds.length ? '已取得任务资料，正在处理。' : '正在理解你的委托。'
    if (record.budget.decisionsRemaining < 1) throw new Error('TASK_BUDGET_EXHAUSTED')
    const input: R1TaskInput = { ...lease, status: 'running', goal: record.goal, constraints: [...record.constraints],
      ...(record.checkpoint.artifactEdit ? { currentArtifact: structuredClone(record.checkpoint.artifactEdit) } : {}),
      sourceRefs: [...record.checkpoint.sourceRefs], currentTime: new Date().toISOString(), timezone: record.checkpoint.source.timezone,
      temporary: record.temporary, budget: structuredClone(record.budget), validReceiptActionIds: [...record.checkpoint.receiptActionIds],
      observations: structuredClone(record.checkpoint.observations), loadedSkillIds: [...record.checkpoint.loadedSkillIds] }
    this.assets.validateStructured('task-input', input)
    record.budget.decisionsRemaining--; this.persist(record); this.emit(record, 'updated')
    return input
  }
  consumeTool(lease: TaskLease, alias: string, identity?: { callId: string; fingerprint: string }): string {
    this.assertLease(lease)
    const record = this.checked(lease.taskId)
    if (record.budget.toolsRemaining < 1) throw new Error('TASK_TOOL_BUDGET_EXHAUSTED')
    if (!record.checkpoint.authorizedAliases.includes(alias)) throw new Error('TASK_TOOL_NOT_AUTHORIZED')
    if (!this.assets.exposeTools({ channel: 'task', loadedSkillIds: record.checkpoint.loadedSkillIds,
      authorizedAliases: record.checkpoint.authorizedAliases, temporary: record.temporary })
      .some(tool => tool.function.name === alias)) throw new Error('MODEL_TOOL_NOT_EXPOSED')
    const prior = identity ? record.checkpoint.actions?.find(action => action.callId === identity.callId && action.runId === lease.runId) : undefined
    if (prior) {
      if (prior.alias !== alias || prior.fingerprint !== identity!.fingerprint) throw new Error('TASK_TOOL_CALL_ID_REUSED')
      record.budget.toolsRemaining--; this.persist(record)
      return prior.actionId
    }
    const actionId = randomUUID()
    record.checkpoint.actions ??= []
    if (record.checkpoint.actions.length >= 50) throw new Error('TASK_ACTION_LIMIT')
    record.checkpoint.actions.push({ actionId, alias, runId: lease.runId,
      ...(identity ? identity : {}) })
    record.budget.toolsRemaining--; this.persist(record)
    return actionId
  }
  loadSkill(lease: TaskLease, skillId: string): void {
    this.assertLease(lease)
    const record = this.checked(lease.taskId)
    this.assets.exposeTools({ channel: 'task', loadedSkillIds: [skillId], authorizedAliases: [], temporary: record.temporary })
    if (!record.checkpoint.loadedSkillIds.includes(skillId)) record.checkpoint.loadedSkillIds.push(skillId)
    this.persist(record)
  }
  originalSource(lease: TaskLease): TaskSource {
    this.assertLease(lease); return structuredClone(this.checked(lease.taskId).checkpoint.source)
  }
  authorizedAliases(lease: TaskLease): string[] {
    this.assertLease(lease); return [...this.checked(lease.taskId).checkpoint.authorizedAliases]
  }
  /** The renderer that started the task owns its pending confirmations. */
  taskOwnerId(taskId: string): number { return this.checked(taskId).checkpoint.ownerId ?? 0 }
  pendingUiActions(taskId: string): PendingUiAction[] {
    const record = this.checked(taskId)
    return (record.checkpoint.pendingUiActions ?? []).filter(item => !record.checkpoint.receiptActionIds.includes(item.actionId))
  }
  bindPendingInvalidator(fn: (taskId: string, actionIds: string[], reason: string) => void): void {
    this.pendingInvalidator = fn
  }
  /**
   * A cancelled/expired/superseded/failed confirmation is a terminal fact for
   * the original Task action: it must stop blocking completion, stay visible to
   * the model as "not executed", and never be retried automatically.
   */
  settlePendingUiAction(taskId: string, actionId: string, outcome: UiActionOutcome['outcome'], detail: string): void {
    const record = this.records.get(taskId)
    if (!record) return
    const pending = record.checkpoint.pendingUiActions ?? []
    const index = pending.findIndex(item => item.actionId === actionId)
    const outcomes = record.checkpoint.uiActionOutcomes ?? []
    const existing = outcomes.find(item => item.actionId === actionId)
    if (index < 0 && existing) return
    if (index >= 0) record.checkpoint.pendingUiActions = pending.filter(item => item.actionId !== actionId)
    if (!existing) {
      const action = (record.checkpoint.actions ?? []).find(item => item.actionId === actionId)
      const alias = action?.alias ?? 'notes_delete'
      const tool = (() => { try { return this.assets.toolDefinition(alias).name } catch { return alias } })()
      outcomes.push({ actionId, alias, outcome, detail: detail.slice(0, 300), at: new Date().toISOString() })
      record.checkpoint.uiActionOutcomes = outcomes.slice(-20)
      record.checkpoint.observations.push({ refId: actionId, kind: 'receipt', version: 1,
        summary: outcome === 'executed' ? `${tool}: 已执行。${detail.slice(0, 220)}`
          : `${tool}: ${outcome}，未执行。${detail.slice(0, 220)}`, resourcePath: null })
      if (record.checkpoint.observations.length > 50) record.checkpoint.observations.splice(0, record.checkpoint.observations.length - 50)
    }
    record.checkpoint.progressBrief = outcome === 'executed' ? '界面确认已完成，已记录真实回执。'
      : '界面确认未执行；任务恢复后以这条事实为准，不自动重试。'
    this.persist(record); this.emit(record, 'updated')
  }
  /** A UI action found a real stored receipt; reflect it without resuming or replaying work. */
  refreshExternalReceipts(taskId: string): R1Task {
    const record = this.checked(taskId)
    const before = record.checkpoint.receiptActionIds.length
    this.adoptExternalReceipts(record)
    if (record.checkpoint.receiptActionIds.length !== before) {
      record.checkpoint.progressBrief = '界面确认已完成，已记录真实回执；可继续核对结果。'
      this.persist(record); this.emit(record, 'updated')
    }
    return this.get(taskId)
  }
  /**
   * A model-issued delete/export waits for the trusted renderer. The run ends
   * immediately instead of spending further decisions or a PR10 repair draft.
   */
  waitForUserAction(lease: TaskLease): TaskResult {
    this.assertLease(lease)
    const record = this.checked(lease.taskId)
    if (record.checkpoint.publicationRunId === lease.runId && record.checkpoint.result) {
      return structuredClone(record.checkpoint.result)
    }
    const receipts = (record.checkpoint.toolReceipts ?? []).map(receipt => {
      const row = this.db.prepare('SELECT status, entity_id FROM receipts WHERE action_id = ?')
        .get(receipt.actionId) as { status: TaskResult['entityReceipts'][number]['status']; entity_id: string | null } | undefined
      const temporary = record.temporary && (receipt.entityId === null || receipt.tool.startsWith('music.'))
      return { actionId: receipt.actionId, tool: receipt.tool, status: temporary ? receipt.status : row?.status ?? 'unknown',
        entityId: row?.entity_id ?? receipt.entityId, summary: '以实际执行回执为准。' }
    })
    const brief = '有一项操作等待你在界面确认；确认后会在原任务记录真实回执。'
    const result: TaskResult = { resultId: randomUUID(), goalVersion: record.goalVersion, completionStatus: 'needs_input',
      replyBrief: brief, sourceRefs: [...record.checkpoint.sourceRefs], artifacts: [], unresolved: ['等待界面确认'],
      candidateRefs: [], entityReceipts: receipts }
    record.checkpoint.result = result; record.checkpoint.publicationRunId = lease.runId
    record.checkpoint.progressBrief = brief
    this.account(record); this.endRun(record, 'waiting_input'); record.status = 'waiting_input'
    this.persist(record); this.emit(record, 'waiting_input')
    return structuredClone(result)
  }
  /**
   * A model-requested UI confirmation is not a domain receipt. It consumes a
   * tool slot, is checkpointed for cancellation, and is returned as ui_action.
   */
  executePendingTool(lease: TaskLease, alias: string, input: unknown,
    prepare: (actionId: string) => Record<string, unknown>, callId?: string): Record<string, unknown> {
    this.assertLease(lease)
    this.assets.validateToolInput(alias, input)
    if (!['notes_delete', 'notes_export'].includes(alias)) throw new Error('TASK_UI_ACTION_UNAVAILABLE')
    if (callId !== undefined && (typeof callId !== 'string' || !callId || callId.length > 300)) throw new Error('TASK_TOOL_CALL_ID_INVALID')
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonical(nested)])) : value
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
    const actionId = this.consumeTool(lease, alias, callId ? { callId, fingerprint } : undefined)
    const record = this.checked(lease.taskId)
    const output = prepare(actionId)
    this.assets.validateToolOutput(alias, output)
    record.checkpoint.pendingUiActions ??= []
    if (!record.checkpoint.pendingUiActions.some(item => item.actionId === actionId)) {
      if (record.checkpoint.pendingUiActions.length >= 8) throw new Error('TASK_UI_ACTION_LIMIT')
      record.checkpoint.pendingUiActions.push({ actionId, alias, runId: lease.runId, goalVersion: record.goalVersion })
      this.persist(record)
    }
    return structuredClone(output)
  }
  private invalidatePending(record: RecordTask, reason: string): void {
    const pending = record.checkpoint.pendingUiActions ?? []
    if (!pending.length) return
    record.checkpoint.pendingUiActions = []
    this.persist(record)
    try { this.pendingInvalidator?.(record.taskId, pending.map(item => item.actionId), reason) } catch { /* committed */ }
  }
  /** Confirmed UI actions are real receipts; adopt them before resuming so the run can reconcile them. */
  private adoptExternalReceipts(record: RecordTask): void {
    for (const action of record.checkpoint.actions ?? []) {
      if (record.checkpoint.receiptActionIds.includes(action.actionId)) continue
      if (!['notes_delete', 'notes_export'].includes(action.alias)) continue
      const row = this.db.prepare('SELECT status, actual_result_json FROM receipts WHERE action_id = ? AND task_id = ?')
        .get(action.actionId, record.taskId) as { status: string; actual_result_json: string } | undefined
      if (!row || row.status !== 'succeeded') continue
      let receipt: TaskToolReceipt
      try { receipt = this.externalReceipt(action, JSON.parse(row.actual_result_json)) } catch { continue }
      record.checkpoint.toolReceipts ??= []
      if (!record.checkpoint.toolReceipts.some(item => item.actionId === receipt.actionId)) record.checkpoint.toolReceipts.push(receipt)
      record.checkpoint.receiptActionIds.push(receipt.actionId)
    }
    record.checkpoint.pendingUiActions = (record.checkpoint.pendingUiActions ?? [])
      .filter(item => !record.checkpoint.receiptActionIds.includes(item.actionId))
  }
  private externalReceipt(action: { actionId: string; alias: string; runId: string },
    parsed: unknown): TaskToolReceipt {
    const tool = this.assets.toolDefinition(action.alias).name
    const value = parsed as { kind?: string; actionId?: string; tool?: string; data?: Record<string, unknown>;
      result?: { itemId?: string; receipt?: { entityVersion?: number }; reminderReceipts?: Array<{ detail?: string; entityId?: string }> } }
    let receipt: TaskToolReceipt
    if (value?.kind === 'receipt') {
      receipt = { kind: 'receipt', actionId: value.actionId!, tool: value.tool!, status: 'succeeded',
        entityId: (value as unknown as TaskToolReceipt).entityId ?? null,
        entityVersion: (value as unknown as TaskToolReceipt).entityVersion ?? null,
        data: value.data ?? {}, errorCode: null, retryable: false, runId: action.runId }
    } else if (value?.result?.itemId) {
      const reminders = value.result.reminderReceipts ?? []
      receipt = { kind: 'receipt', actionId: action.actionId, tool, status: 'succeeded', entityId: value.result.itemId,
        entityVersion: value.result.receipt?.entityVersion ?? null,
        data: { itemId: value.result.itemId, deleted: true,
          remainingReminderIds: reminders.filter(reminder => reminder.detail === 'reminder_kept').map(reminder => reminder.entityId),
          reminderReceipts: reminders }, errorCode: null, retryable: false, runId: action.runId }
    } else throw new Error('TASK_RECEIPT_RECONCILIATION_REQUIRED')
    if (receipt.tool !== tool || receipt.actionId !== action.actionId) throw new Error('TASK_RECEIPT_RECONCILIATION_REQUIRED')
    this.assets.validateToolOutput(action.alias, receipt)
    return receipt
  }
  steeringEvent(lease: TaskLease): Record<string, unknown> | undefined {
    this.assertLease(lease)
    const record = this.checked(lease.taskId)
    if (!record.checkpoint.steerEventId) return undefined
    return { eventId: record.checkpoint.steerEventId, taskId: record.taskId, newGoalVersion: record.goalVersion,
      currentStatus: 'running', goal: record.goal, constraints: [...record.constraints],
      sourceTurnIds: [record.checkpoint.source.turnId], validReceiptActionIds: [...record.checkpoint.receiptActionIds] }
  }
  assertToolSources(lease: TaskLease, refs: string[]): void {
    this.assertLease(lease)
    const record = this.checked(lease.taskId)
    if (refs.some(ref => !record.checkpoint.sourceRefs.includes(ref) ||
      this.db.prepare('SELECT 1 FROM source_suppression WHERE source_ref = ?').get(ref))) throw new Error('TASK_TOOL_SOURCE_INVALID')
  }
  assertPersistenceAllowed(lease: TaskLease): void {
    this.assertLease(lease)
    const record = this.checked(lease.taskId)
    if (record.temporary && !record.checkpoint.persistenceConfirmed) throw new Error('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
  }
  /** Synchronous local tools commit their state and real receipt together. No external I/O here. */
  executeLocalTool(lease: TaskLease, alias: string, input: unknown, run: (actionId: string) => {
    data: Record<string, unknown>; entityId?: string | null; entityVersion?: number | null
  }, callId?: string): TaskToolReceipt {
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonical(nested)])) : value
    if (callId !== undefined && (typeof callId !== 'string' || !callId || callId.length > 300)) throw new Error('TASK_TOOL_CALL_ID_INVALID')
    const fingerprint = createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
    const actionId = this.consumeTool(lease, alias, callId ? { callId, fingerprint } : undefined)
    const current = this.checked(lease.taskId)
    if (current.checkpoint.receiptActionIds.includes(actionId)) {
      const previous = this.readReceipt(lease, actionId)
      if (previous.status === 'unknown') throw new Error('TASK_RECEIPT_RECONCILIATION_REQUIRED')
      return previous
    }
    if (current.checkpoint.actions?.find(action => action.actionId === actionId)!.runId !== lease.runId) {
      throw new Error('TASK_RECEIPT_RECONCILIATION_REQUIRED')
    }
    const record = this.checked(lease.taskId); const previous = structuredClone(record)
    const events: TaskEvent[] = []
    this.pendingEvents = events
    let output: TaskToolReceipt
    try {
      output = inTransaction(this.db, () => {
        this.assertLease(lease)
        const result = run(actionId)
        this.assertLease(lease)
        const receipt: TaskToolReceipt = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name,
          status: 'succeeded', entityId: result.entityId ?? null, entityVersion: result.entityVersion ?? null,
          data: result.data, errorCode: null, retryable: false, runId: lease.runId }
        this.storeLocalReceipt(lease, receipt)
        return receipt
      })
    } catch (error) {
      this.records.set(record.taskId, previous)
      events.length = 0
      this.assertLease(lease)
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'TASK_TOOL_FAILED'
      output = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name,
        status: 'failed', entityId: null, entityVersion: null, data: {}, errorCode: code, retryable: false, runId: lease.runId }
      inTransaction(this.db, () => this.storeLocalReceipt(lease, output))
    } finally { this.pendingEvents = null }
    for (const event of events) for (const listener of this.listeners) { try { listener(structuredClone(event)) } catch { /* committed */ } }
    return structuredClone(output)
  }
  /** Reserve authority before audio I/O; keep actual device receipts even if the run is cancelled. */
  async executeMusicTool(lease: TaskLease, alias: string, input: unknown, run: () => Promise<Record<string, unknown>>, callId?: string): Promise<TaskToolReceipt> {
    this.assertLease(lease); this.assets.validateToolInput(alias, input)
    if (!alias.startsWith('music_')) throw new Error('TASK_TOOL_IMPLEMENTATION_UNAVAILABLE')
    if (callId !== undefined && (!callId || callId.length > 300)) throw new Error('TASK_TOOL_CALL_ID_INVALID')
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonical(nested)])) : value
    const fingerprint = JSON.stringify({ alias, input: canonical(input) })
    const key = callId ? `${lease.runId}:${callId}` : randomUUID()
    const pending = this.musicOperations.get(key)
    if (pending) { if (pending.fingerprint !== fingerprint) throw new Error('TASK_TOOL_CALL_ID_REUSED'); return pending.promise }
    const promise = this.executeMusicToolOnce(lease, alias, canonical(input), run, callId).finally(() => { this.musicOperations.delete(key) })
    this.musicOperations.set(key, { fingerprint, promise }); return promise
  }
  private async executeMusicToolOnce(lease: TaskLease, alias: string, input: unknown, run: () => Promise<Record<string, unknown>>, callId?: string): Promise<TaskToolReceipt> {
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const actionId = this.consumeTool(lease, alias, callId ? { callId, fingerprint } : undefined)
    const record = this.checked(lease.taskId)
    if (record.checkpoint.receiptActionIds.includes(actionId)) {
      const previous = this.readReceipt(lease, actionId)
      if (previous.status === 'unknown') throw new Error('TASK_RECEIPT_RECONCILIATION_REQUIRED')
      return previous
    }
    if (record.checkpoint.actions!.find(action => action.actionId === actionId)!.runId !== lease.runId) throw new Error('TASK_RECEIPT_RECONCILIATION_REQUIRED')
    let receipt: TaskToolReceipt
    try {
      const data = await run()
      receipt = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name, status: 'succeeded',
        entityId: (data.state as { track?: { trackKey?: string } } | undefined)?.track?.trackKey ?? null,
        entityVersion: (data.state as { playerVersion?: number } | undefined)?.playerVersion ?? null, data, errorCode: null, retryable: false, runId: lease.runId }
      this.assets.validateToolOutput(alias, receipt)
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'MUSIC_OPERATION_FAILED'
      receipt = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name,
        status: code === 'MUSIC_PLAYBACK_UNKNOWN' ? 'unknown' : ['MUSIC_SUPERSEDED', 'TASK_NOT_RUNNING', 'TASK_CONTEXT_STALE'].includes(code) ? 'cancelled' : 'failed',
        entityId: null, entityVersion: null, data: {}, errorCode: code, retryable: false, runId: lease.runId }
    }
    this.assets.validateToolOutput(alias, receipt)
    // An audio device may have acted before a cancellation/goal change. Keep its
    // actual receipt, then reject the stale model continuation instead of hiding the action.
    const current = this.records.get(lease.taskId)
    if (current && current.checkpoint.actions?.some(action => action.actionId === actionId && action.runId === lease.runId)) {
      inTransaction(this.db, () => {
        if (!current.temporary) this.db.prepare(`INSERT INTO receipts(action_id,task_id,run_id,entity_id,entity_version,status,actual_result_json,created_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(actionId, lease.taskId, lease.runId, receipt.entityId, receipt.entityVersion, receipt.status, JSON.stringify(receipt), new Date().toISOString())
        current.checkpoint.toolReceipts ??= []; current.checkpoint.toolReceipts.push(structuredClone(receipt))
        current.checkpoint.receiptActionIds.push(actionId)
        current.checkpoint.observations.push({ refId: actionId, kind: 'receipt', version: 1, summary: `${receipt.tool}: ${receipt.status}`, resourcePath: `/task/${lease.taskId}/receipts/${actionId}.json` })
        this.persist(current)
      })
    }
    this.assertLease(lease); this.emit(this.checked(lease.taskId), 'updated'); return receipt
  }

  async executeReadTool(lease: TaskLease, alias: string, input: unknown,
    run: () => Promise<Record<string, unknown>>, callId?: string): Promise<TaskToolReceipt> {
    this.assertLease(lease)
    this.assets.validateToolInput(alias, input)
    if (!['web_search', 'web_read_page'].includes(alias)) throw new Error('TASK_EXTERNAL_READ_UNAVAILABLE')
    if (callId !== undefined && (!callId || callId.length > 300)) throw new Error('TASK_TOOL_CALL_ID_INVALID')
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const actionId = this.consumeTool(lease, alias, callId ? { callId, fingerprint } : undefined)
    const record = this.checked(lease.taskId)
    if (record.checkpoint.receiptActionIds.includes(actionId)) return this.readReceipt(lease, actionId)
    if (record.checkpoint.actions!.find(action => action.actionId === actionId)!.runId !== lease.runId) throw new Error('TASK_RECEIPT_RECONCILIATION_REQUIRED')
    const budgetKey = alias === 'web_search' ? 'searchQueriesRemaining' : 'pagesRemaining'
    let receipt: TaskToolReceipt
    try {
      if (record.budget[budgetKey] < 1) throw new Error(alias === 'web_search' ? 'TASK_SEARCH_BUDGET_EXHAUSTED' : 'TASK_PAGE_BUDGET_EXHAUSTED')
      record.checkpoint.progressBrief = alias === 'web_search' ? '正在检索信息。' : '正在读取已找到的公开页面。'
      this.emit(record, 'updated')
      record.budget[budgetKey]--; this.persist(record)
      const data = await run()
      receipt = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name,
        status: 'succeeded', entityId: null, entityVersion: null, data, errorCode: null, retryable: false, runId: lease.runId }
      this.assets.validateToolOutput(alias, receipt)
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'SEARCH_REMOTE_FAILED'
      receipt = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name, status: 'failed',
        entityId: null, entityVersion: null, data: {}, errorCode: code, retryable: code === 'SEARCH_NETWORK_FAILED', runId: lease.runId }
    }
    this.assertLease(lease)
    const current = this.checked(lease.taskId), previous = structuredClone(current)
    try {
      inTransaction(this.db, () => {
        this.storeLocalReceipt(lease, receipt)
        if (receipt.status === 'succeeded') {
          const sources = (alias === 'web_search' ? receipt.data.sources : [receipt.data.source]) as Array<{ sourceRef: string; title: string }>
          const candidates = (alias === 'web_search' ? receipt.data.candidates : []) as Array<{ candidateId: string; label: string }>
          const resourcePath = `/task/${lease.taskId}/receipts/${actionId}.json`
          for (const source of sources) {
            if (!current.checkpoint.sourceRefs.includes(source.sourceRef)) current.checkpoint.sourceRefs.push(source.sourceRef)
            const prior = current.checkpoint.observations.find(item => item.refId === source.sourceRef)
            if (prior) { prior.resourcePath = resourcePath; prior.summary = source.title; prior.version = (prior.version ?? 0) + 1 }
            else if (alias === 'web_read_page') current.checkpoint.observations.push({ refId: source.sourceRef, kind: 'source', version: 1, summary: source.title, resourcePath })
          }
          for (const candidate of candidates) {
            const prior = current.checkpoint.observations.find(item => item.refId === candidate.candidateId && item.kind === 'candidate')
            if (prior) { prior.version = (prior.version ?? 1) + 1; prior.summary = candidate.label; prior.resourcePath = resourcePath }
            else current.checkpoint.observations.push({ refId: candidate.candidateId, kind: 'candidate', version: 1, summary: candidate.label, resourcePath })
          }
          if (current.checkpoint.sourceRefs.length > 50 || current.checkpoint.observations.length > 50) throw new Error('TASK_OBSERVATION_LIMIT')
          this.persist(current)
        }
      })
    } catch (error) { this.records.set(current.taskId, previous); throw error }
    this.emit(current, 'updated')
    return structuredClone(receipt)
  }
  private storeLocalReceipt(lease: TaskLease, receipt: TaskToolReceipt): void {
    this.assertLease(lease)
    const record = this.checked(lease.taskId)
    this.assets.validateToolOutput(record.checkpoint.actions!.find(action => action.actionId === receipt.actionId)!.alias, receipt)
    if (record.checkpoint.receiptActionIds.length >= 50) throw new Error('TASK_RECEIPT_LIMIT')
    const stored = this.db.prepare('SELECT status, entity_id, entity_version FROM receipts WHERE action_id = ?').get(receipt.actionId) as {
      status: string; entity_id: string | null; entity_version: number | null
    } | undefined
    if (stored && (stored.status !== receipt.status || stored.entity_id !== receipt.entityId || stored.entity_version !== receipt.entityVersion)) {
      throw new Error('TASK_RECEIPT_NOT_VERIFIED')
    }
    if (!record.temporary) {
      if (stored) this.db.prepare('UPDATE receipts SET task_id = ?, run_id = ? WHERE action_id = ?')
        .run(record.taskId, lease.runId, receipt.actionId)
      else this.db.prepare(`INSERT INTO receipts (action_id, task_id, run_id, entity_id, entity_version, status, actual_result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(receipt.actionId, record.taskId, lease.runId, receipt.entityId,
          receipt.entityVersion, receipt.status, JSON.stringify(receipt), new Date().toISOString())
    }
    record.checkpoint.toolReceipts ??= []; record.checkpoint.toolReceipts.push(structuredClone(receipt))
    record.checkpoint.receiptActionIds.push(receipt.actionId)
    record.checkpoint.observations.push({ refId: receipt.actionId, kind: 'receipt', version: 1,
      summary: `${receipt.tool}: ${receipt.status}`, resourcePath: `/task/${record.taskId}/receipts/${receipt.actionId}.json` })
    this.persist(record)
  }
  readReceipt(lease: TaskLease, actionId: string): TaskToolReceipt {
    this.assertLease(lease)
    const record = this.checked(lease.taskId)
    const output = record.checkpoint.toolReceipts?.find(receipt => receipt.actionId === actionId)
    if (!output) throw new Error('TASK_RECEIPT_NOT_VERIFIED')
    if (!record.temporary || output.entityId !== null && !output.tool.startsWith('music.')) {
      const row = this.db.prepare('SELECT status, task_id FROM receipts WHERE action_id = ?').get(actionId) as { status: string; task_id: string } | undefined
      if (!row || row.status !== output.status || (!record.temporary && row.task_id !== record.taskId)) throw new Error('TASK_RECEIPT_RECONCILIATION_REQUIRED')
    }
    return structuredClone(output)
  }
  verifyRecovery(lease: TaskLease): void {
    this.assertLease(lease)
    const record = this.checked(lease.taskId)
    const notExecuted = new Set((record.checkpoint.uiActionOutcomes ?? [])
      .filter(item => item.outcome !== 'executed').map(item => item.actionId))
    for (const action of record.checkpoint.actions ?? []) {
      if (action.runId === lease.runId) continue
      if (notExecuted.has(action.actionId)) continue
      if (!record.checkpoint.receiptActionIds.includes(action.actionId)) throw new Error('TASK_RECEIPT_RECONCILIATION_REQUIRED')
      const canonical = record.checkpoint.toolReceipts?.find(receipt => receipt.actionId === action.actionId)
      if (!canonical || canonical.status === 'unknown') throw new Error('TASK_RECEIPT_RECONCILIATION_REQUIRED')
      this.readReceipt(lease, action.actionId)
    }
  }
  stopRun(lease: TaskLease, code: string): void {
    const record = this.checked(lease.taskId)
    if (record.status !== 'running' || record.checkpoint.runId !== lease.runId || record.goalVersion !== lease.goalVersion ||
      record.checkpoint.contextVersion !== lease.contextVersion) return
    if (record.checkpoint.deletionEpoch !== this.deletionEpoch()) { this.invalidateContext(); return }
    if (record.checkpoint.stopRequested === 'paused') { this.settlePause(lease); return }
    this.account(record)
    record.checkpoint.budgetStopped = code.includes('BUDGET')
    const receipts = (record.checkpoint.toolReceipts ?? []).map(receipt => {
      const row = this.db.prepare('SELECT status, entity_id FROM receipts WHERE action_id = ?').get(receipt.actionId) as {
        status: TaskToolReceipt['status']; entity_id: string | null
      } | undefined
      const status = record.temporary && (receipt.entityId === null || receipt.tool.startsWith('music.')) ? receipt.status : row?.status ?? 'unknown'
      return { actionId: receipt.actionId, tool: receipt.tool, status,
        entityId: row?.entity_id ?? receipt.entityId, summary: '以实际执行回执为准。' }
    })
    const brief = record.checkpoint.budgetStopped ? '已达到本次处理预算；可以查看已执行结果并选择继续。'
      : code === 'VERSION_CONFLICT' ? '工作稿已有新版本，已保留你的修改。请查看新稿后重新提出续改要求。'
        : code === 'ARTIFACT_OUTSIDE_TARGET_CHANGED' ? '生成的修改超出了目标范围，原稿未改动。请重新提出修改要求。'
          : code === 'TASK_RECEIPT_RECONCILIATION_REQUIRED' ? '已有步骤的回执需要核对，已停止继续执行。' : '本次处理未完成，已保存可核验的执行记录。'
    record.checkpoint.result = { resultId: randomUUID(), goalVersion: record.goalVersion, completionStatus: 'partial',
      replyBrief: brief, sourceRefs: [...record.checkpoint.sourceRefs], artifacts: [], unresolved: [code], candidateRefs: [], entityReceipts: receipts }
    record.checkpoint.progressBrief = brief
    const status = code === 'STRUCTURED_OUTPUT_INVALID' ? 'failed' : 'partially_succeeded'
    this.endRun(record, status); record.status = status
    this.persist(record); this.emit(record, 'completed')
  }
  recordInternalReceipt(lease: TaskLease, receipt: TaskToolReceipt): void {
    this.assertLease(lease)
    const record = this.checked(lease.taskId)
    const action = record.checkpoint.actions?.find(action => action.actionId === receipt.actionId && action.runId === lease.runId)
    if (!action || !['read_file', 'write_todos'].includes(action.alias) || receipt.runId !== lease.runId) throw new Error('TASK_RECEIPT_SCOPE_INVALID')
    this.assets.validateToolOutput(action.alias, receipt)
    if (record.checkpoint.receiptActionIds.includes(receipt.actionId)) return
    if (record.checkpoint.receiptActionIds.length >= 50) throw new Error('TASK_RECEIPT_LIMIT')
    inTransaction(this.db, () => {
      if (!record.temporary) this.db.prepare(`INSERT INTO receipts
        (action_id, task_id, run_id, entity_id, entity_version, status, actual_result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(receipt.actionId, record.taskId, lease.runId, receipt.entityId, receipt.entityVersion,
          receipt.status, JSON.stringify(receipt), new Date().toISOString())
      record.checkpoint.toolReceipts ??= []; record.checkpoint.toolReceipts.push(structuredClone(receipt))
      record.checkpoint.receiptActionIds.push(receipt.actionId); this.persist(record)
    })
  }
  updatePlan(lease: TaskLease, steps: PlanStep[]): { taskId: string; planVersion: number; steps: PlanStep[] } {
    this.assertLease(lease); this.assets.validateToolInput('write_todos', { steps })
    const byId = new Map(steps.map(step => [step.stepId, step]))
    if (byId.size !== steps.length || steps.some(step => !step.stepId.trim() ||
      step.dependsOn.some(id => !byId.has(id) || id === step.stepId))) throw new Error('TASK_PLAN_DEPENDENCY_INVALID')
    const visited = new Set<string>(); const active = new Set<string>()
    const visit = (id: string): void => {
      if (active.has(id)) throw new Error('TASK_PLAN_CYCLE')
      if (visited.has(id)) return
      active.add(id); byId.get(id)!.dependsOn.forEach(visit); active.delete(id); visited.add(id)
    }
    steps.forEach(step => visit(step.stepId))
    const record = this.checked(lease.taskId)
    record.checkpoint.plan = structuredClone(steps); record.checkpoint.planVersion++
    this.persist(record); this.emit(record, 'plan')
    return { taskId: record.taskId, planVersion: record.checkpoint.planVersion, steps: structuredClone(steps) }
  }
  /** Executor records only a real stored receipt with an action ID allocated for this run. */
  recordReceipt(lease: TaskLease, actionId: string): void {
    this.assertLease(lease)
    const record = this.checked(lease.taskId)
    const receipt = this.db.prepare('SELECT task_id, run_id FROM receipts WHERE action_id = ?')
      .get(actionId) as { task_id: string | null; run_id: string | null } | undefined
    if (!receipt || record.temporary || !record.checkpoint.actions?.some(action => action.actionId === actionId && action.runId === lease.runId)) {
      throw new Error('TASK_RECEIPT_NOT_VERIFIED')
    }
    if (receipt.task_id && receipt.task_id !== record.taskId) throw new Error('TASK_RECEIPT_SCOPE_INVALID')
    if (receipt.run_id && receipt.run_id !== lease.runId) throw new Error('TASK_RECEIPT_SCOPE_INVALID')
    if (record.checkpoint.receiptActionIds.includes(actionId)) return
    if (record.checkpoint.receiptActionIds.length >= 50) throw new Error('TASK_RECEIPT_LIMIT')
    inTransaction(this.db, () => {
      this.db.prepare('UPDATE receipts SET task_id = ?, run_id = ? WHERE action_id = ?').run(record.taskId, lease.runId, actionId)
      record.checkpoint.receiptActionIds.push(actionId); this.persist(record)
    })
  }
  publish(lease: TaskLease, value: unknown, artifacts: R1Artifacts): TaskResult {
    const record = this.checked(lease.taskId)
    if (record.checkpoint.publicationRunId === lease.runId && record.checkpoint.result?.goalVersion === lease.goalVersion) {
      if (record.checkpoint.deletionEpoch !== this.deletionEpoch()) throw new Error('TASK_CONTEXT_STALE')
      return structuredClone(record.checkpoint.result)
    }
    this.assertLease(lease); this.assets.validateStructured('task-draft', value)
    this.adoptExternalReceipts(record)
    const draft = value as TaskDraft
    if (draft.goalVersion !== record.goalVersion) throw new Error('TASK_CONTEXT_STALE')
    if (draft.status === 'completed' && draft.unresolved.length) throw new Error('TASK_COMPLETION_INCONSISTENT')
    // A delete/export waiting for the trusted renderer has no domain receipt;
    // the task cannot claim completion until the user actually decides.
    if (draft.status === 'completed' && (record.checkpoint.pendingUiActions ?? []).some(item =>
      !record.checkpoint.receiptActionIds.includes(item.actionId))) throw new Error('TASK_COMPLETION_UI_PENDING')
    // A delegated web investigation cannot be completed from model memory.
    // Enforce evidence independently of M01's optional requiredActions list.
    if (draft.status === 'completed') {
      for (const alias of ['web_search', 'web_read_page']) {
        if (!record.checkpoint.authorizedAliases.includes(alias)) continue
        const evidence = (record.checkpoint.toolReceipts ?? []).filter(receipt =>
          receipt.tool === this.assets.toolDefinition(alias).name && receipt.status === 'succeeded' &&
          draft.receiptActionIds.includes(receipt.actionId) &&
          (alias === 'web_search' ? (receipt.data.sources as Array<{ sourceRef: string; readStatus?: string }> ?? [])
            : [receipt.data.source as { sourceRef: string; readStatus: string }]).some(source => source &&
              draft.sourceRefs.includes(source.sourceRef) &&
              (alias !== 'web_read_page' || ['read', 'partial'].includes(source.readStatus ?? ''))))
        if (!evidence.length) throw new Error('TASK_COMPLETION_WEB_EVIDENCE_MISSING')
      }
    }
    for (const requirement of record.checkpoint.requiredActions ?? []) if (draft.status === 'completed') {
      const actual = (record.checkpoint.toolReceipts ?? []).filter(receipt => receipt.tool === this.assets.toolDefinition(requirement.alias).name &&
        receipt.status === 'succeeded' && draft.receiptActionIds.includes(receipt.actionId))
      if (actual.length < requirement.minimumCount) throw new Error('TASK_COMPLETION_REQUIRED_RECEIPT_MISSING')
    }
    draft.artifacts.forEach(artifact => artifacts.validateDraft(artifact))
    const sources = new Set(record.checkpoint.sourceRefs)
    const refs = [...draft.sourceRefs, ...draft.artifacts.flatMap(artifact => artifact.sourceRefs),
      ...draft.candidates.flatMap(candidate => candidate.sourceRefs)]
    if (refs.some(ref => !sources.has(ref) || this.db.prepare('SELECT 1 FROM source_suppression WHERE source_ref = ?').get(ref))) {
      throw new Error('TASK_RESULT_SOURCE_INVALID')
    }
    if (draft.candidates.some(candidate => !record.checkpoint.observations.some(observation =>
      observation.kind === 'candidate' && observation.refId === candidate.candidateId))) throw new Error('TASK_RESULT_CANDIDATE_INVALID')
    const receipts = draft.receiptActionIds.map(actionId => {
      if (!record.checkpoint.receiptActionIds.includes(actionId)) throw new Error('TASK_RESULT_RECEIPT_INVALID')
      const temporaryReceipt = record.temporary ? this.readReceipt(lease, actionId) : undefined
      const row = temporaryReceipt ? { status: temporaryReceipt.status, entity_id: temporaryReceipt.entityId }
        : this.db.prepare('SELECT * FROM receipts WHERE action_id = ? AND task_id = ?').get(actionId, record.taskId) as {
        status: TaskResult['entityReceipts'][number]['status']; entity_id: string | null
      } | undefined
      if (!row) throw new Error('TASK_RESULT_RECEIPT_INVALID')
      if (draft.status === 'completed' && row.status !== 'succeeded') throw new Error('TASK_COMPLETION_INCONSISTENT')
      const action = record.checkpoint.actions!.find(action => action.actionId === actionId)!
      return { actionId, tool: this.assets.toolDefinition(action.alias).name,
        status: row.status, entityId: row.entity_id, summary: '以实际执行回执为准。' }
    })
    if (draft.status === 'completed' && record.checkpoint.receiptActionIds.some(id => !draft.receiptActionIds.includes(id) &&
      ['write', 'media', 'ui_then_write'].includes(this.assets.toolDefinition(record.checkpoint.actions!.find(action => action.actionId === id)!.alias).effect))) {
      throw new Error('TASK_RESULT_RECEIPT_OMITTED')
    }
    const baseIds = draft.artifacts.map(artifact => artifact.baseArtifactId).filter(id => id !== null)
    const edit = record.checkpoint.artifactEdit
    if (edit && (draft.artifacts.some(artifact => artifact.baseArtifactId !== edit.artifact.artifactId || artifact.baseArtifactVersion !== edit.artifact.version) ||
      draft.status === 'completed' && draft.artifacts.length !== 1)) throw new Error('TASK_RESULT_ARTIFACT_INVALID')
    if (new Set(baseIds).size !== baseIds.length) throw new Error('TASK_ARTIFACT_BASE_REUSED')
    for (const artifact of draft.artifacts) if (artifact.baseArtifactId !== null) {
      const permitted = record.checkpoint.observations.find(observation => observation.kind === 'artifact' &&
        observation.refId === artifact.baseArtifactId && observation.version === artifact.baseArtifactVersion)
      if (!permitted) throw new Error('TASK_RESULT_ARTIFACT_INVALID')
      if (artifacts.get(artifact.baseArtifactId, record.temporary ? record.checkpoint.source.sessionId : null).version !== artifact.baseArtifactVersion) {
        throw new Error('VERSION_CONFLICT')
      }
      if (edit?.target && artifact.title !== edit.artifact.title) throw new Error('ARTIFACT_OUTSIDE_TARGET_CHANGED')
    } else if (artifact.baseArtifactVersion !== null) throw new Error('TASK_ARTIFACT_BASE_INVALID')
    const publish = (): TaskResult => {
      this.assertLease(lease)
      const published = draft.artifacts.map(draft => {
        const owner = record.temporary ? record.checkpoint.source.sessionId : null
        const artifact = draft.baseArtifactId ? artifacts.revise({ artifactId: draft.baseArtifactId,
          expectedVersion: draft.baseArtifactVersion!, content: draft.content, title: draft.title, temporaryOwner: owner,
          sourceRefs: [...new Set([...artifacts.get(draft.baseArtifactId, owner).sourceRefs, ...draft.sourceRefs])], target: edit?.target })
          : artifacts.create({ sourceTurnId: record.checkpoint.source.turnId, draft, temporaryOwner: owner })
        const actionId = randomUUID()
        if (!record.temporary) this.db.prepare(`INSERT INTO receipts
          (action_id, task_id, run_id, entity_id, entity_version, status, actual_result_json, created_at)
          VALUES (?, ?, ?, ?, ?, 'succeeded', ?, ?)`).run(actionId, record.taskId, lease.runId, artifact.artifactId, artifact.version,
            JSON.stringify({ artifactId: artifact.artifactId, version: artifact.version }), new Date().toISOString())
        receipts.push({ actionId, tool: 'artifacts.publish', status: 'succeeded', entityId: artifact.artifactId, summary: '工作稿版本已提交。' })
        return { artifactId: artifact.artifactId, version: artifact.version, title: artifact.title, content: artifact.content }
      })
      const result: TaskResult = { resultId: randomUUID(), goalVersion: record.goalVersion, completionStatus: draft.status,
        replyBrief: draft.replyBrief, sourceRefs: [...draft.sourceRefs], artifacts: published,
        unresolved: [...draft.unresolved], candidateRefs: draft.candidates.map(candidate => candidate.candidateId), entityReceipts: receipts }
      record.checkpoint.result = result; record.checkpoint.publicationRunId = lease.runId
      record.checkpoint.progressBrief = draft.replyBrief
      record.status = draft.status === 'completed' ? 'succeeded' : draft.status === 'partial' ? 'partially_succeeded' : 'waiting_input'
      this.account(record)
      if (!record.temporary) this.db.prepare('UPDATE task_runs SET status = ?, ended_at = ? WHERE run_id = ? AND ended_at IS NULL')
        .run(record.status, new Date().toISOString(), lease.runId)
      this.persist(record)
      return result
    }
    const previous = structuredClone(record)
    let result: TaskResult
    try { result = record.temporary ? artifacts.inTemporaryTransaction(record.checkpoint.source.sessionId, publish)
      : inTransaction(this.db, publish) }
    catch (error) { this.records.set(record.taskId, previous); throw error }
    this.endRun(record, record.status); this.persist(record)
    this.emit(record, record.status === 'waiting_input' ? 'waiting_input' : 'completed')
    return structuredClone(result)
  }
  private endRun(record: RecordTask, status: string): void {
    this.account(record); this.anchors.delete(record.taskId)
    const runId = record.checkpoint.runId
    if (runId) {
      this.controllers.get(runId)?.abort(); this.controllers.delete(runId)
      if (!record.temporary) this.db.prepare('UPDATE task_runs SET status = ?, ended_at = ? WHERE run_id = ? AND ended_at IS NULL')
        .run(status, new Date().toISOString(), runId)
    }
  }
  pause(taskId: string, expectedGoalVersion: number): R1Task {
    const record = this.checked(taskId, expectedGoalVersion)
    if (record.status === 'accepted') { record.status = 'paused'; this.persist(record); this.emit(record, 'paused') }
    else if (record.status === 'running') {
      record.checkpoint.stopRequested = 'paused'; record.checkpoint.progressBrief = '正在暂停，等待当前步骤安全结束。'
      this.controllers.get(record.checkpoint.runId!)?.abort(); this.persist(record); this.emit(record, 'pause_requested')
    } else throw new Error('TASK_INVALID_STATE')
    return this.get(taskId)
  }
  settlePause(lease: TaskLease): void {
    const record = this.checked(lease.taskId)
    if (record.checkpoint.runId !== lease.runId || record.checkpoint.stopRequested !== 'paused') return
    this.endRun(record, 'paused'); record.status = 'paused'; record.checkpoint.stopRequested = null
    this.persist(record); this.emit(record, 'paused')
  }
  cancel(taskId: string, expectedGoalVersion: number): R1Task {
    const record = this.checked(taskId, expectedGoalVersion)
    if (!['accepted', 'running', 'paused', 'needs_resume', 'waiting_input'].includes(record.status)) throw new Error('TASK_INVALID_STATE')
    this.invalidatePending(record, 'TASK_CANCELLED')
    this.endRun(record, 'cancelled'); record.status = 'cancelled'; record.checkpoint.stopRequested = 'cancelled'
    record.checkpoint.progressBrief = '已取消；已提交的事项和提醒仍保留。'
    this.persist(record); this.emit(record, 'cancelled'); return this.get(taskId)
  }
  resume(taskId: string, expectedGoalVersion: number): R1Task {
    const record = this.checked(taskId, expectedGoalVersion)
    if (this.suspended) throw new Error('TASK_DEVICE_SUSPENDED')
    if (!['paused', 'needs_resume', 'waiting_input', 'partially_succeeded'].includes(record.status)) throw new Error('TASK_INVALID_STATE')
    this.source(record.checkpoint.source.messageId)
    if (record.assetReleaseId !== this.assets.releaseId) throw new Error('TASK_ASSET_RELEASE_UNAVAILABLE')
    if (record.checkpoint.deletionEpoch !== this.deletionEpoch()) throw new Error('TASK_CONTEXT_REVALIDATION_REQUIRED')
    this.adoptExternalReceipts(record)
    let renewedBudget: R1TaskInput['budget'] | null = null
    if (record.budget.decisionsRemaining < 1 || record.budget.activeMsRemaining < 1 || record.checkpoint.budgetStopped) {
      if (!record.checkpoint.budgetStopped || !record.checkpoint.initialBudget) throw new Error('TASK_BUDGET_EXHAUSTED')
      renewedBudget = structuredClone(record.checkpoint.initialBudget)
    }
    if ([...this.records.values()].filter(value => ['accepted', 'running'].includes(value.status)).length >= 4) throw new Error('TASK_QUEUE_FULL')
    if (renewedBudget) record.budget = renewedBudget
    record.status = 'accepted'; record.checkpoint.runId = null; record.checkpoint.stopRequested = null
    record.checkpoint.budgetStopped = false
    record.checkpoint.progressBrief = '准备继续，先核对已提交的步骤。'
    this.persist(record); this.emit(record, 'accepted'); return this.get(taskId)
  }
  steer(input: { taskId: string; expectedGoalVersion: number; goal: string; constraints: string[]; sourceMessageId: string;
    authorizedAliases?: string[]; selectedTrackKey?: string | null; requiredActions?: Array<{ alias: string; minimumCount: number }>; artifactEdit?: ArtifactEditBinding | null }): R1Task {
    if (input.selectedTrackKey !== undefined && input.selectedTrackKey !== null) requireText(input.selectedTrackKey, 160, 'TASK_TRACK_INVALID')
    const record = this.checked(input.taskId, input.expectedGoalVersion)
    if (record.assetReleaseId !== this.assets.releaseId) throw new Error('TASK_ASSET_RELEASE_UNAVAILABLE')
    if (['succeeded', 'failed', 'cancelled'].includes(record.status)) throw new Error('TASK_INVALID_STATE')
    const source = this.source(input.sourceMessageId)
    if (source.temporary !== record.temporary || (record.temporary && source.sessionId !== record.checkpoint.source.sessionId)) {
      throw new Error('TASK_SOURCE_SCOPE_INVALID')
    }
    requireText(input.goal, 2000, 'TASK_GOAL_INVALID')
    if (!Array.isArray(input.constraints) || input.constraints.length > 50) throw new Error('TASK_CONSTRAINT_INVALID')
    input.constraints.forEach(value => requireText(value, 500, 'TASK_CONSTRAINT_INVALID'))
    this.assertArtifactBinding(input.artifactEdit, source)
    if (input.authorizedAliases) {
      this.assets.exposeTools({ channel: 'task', loadedSkillIds: [], authorizedAliases: input.authorizedAliases, temporary: record.temporary })
      if ((input.requiredActions ?? []).some(action => !input.authorizedAliases!.includes(action.alias) ||
        !Number.isSafeInteger(action.minimumCount) || action.minimumCount < 1 || action.minimumCount > 50)) throw new Error('TASK_REQUIREMENTS_INVALID')
    }
    const previousStatus = record.status
    this.invalidatePending(record, 'TASK_STEERED')
    this.endRun(record, 'superseded')
    record.goal = input.goal; record.constraints = [...input.constraints]; record.goalVersion++
    if (input.authorizedAliases) {
      record.checkpoint.authorizedAliases = [...input.authorizedAliases]
      record.checkpoint.requiredActions = structuredClone(input.requiredActions ?? [])
    }
    record.checkpoint.steerEventId = randomUUID()
    record.checkpoint.contextVersion++; record.checkpoint.deletionEpoch = this.deletionEpoch()
    source.selectedTrackKey = input.selectedTrackKey ?? null
    source.timezone = record.checkpoint.source.timezone; record.checkpoint.source = source
    record.checkpoint.artifactEdit = structuredClone(input.artifactEdit ?? null)
    record.checkpoint.sourceRefs = [source.messageId]; record.checkpoint.observations = [{ refId: source.messageId,
      kind: 'source', version: 1, summary: JSON.stringify({ turnId: source.turnId, createdAt: source.createdAt, timezone: source.timezone,
        requiredActions: record.checkpoint.requiredActions ?? [] }),
      resourcePath: `/task/${record.taskId}/source-turn.json` }]
    this.attachArtifactObservation(record)
    record.checkpoint.runId = null; record.checkpoint.stopRequested = null
    delete record.checkpoint.result; delete record.checkpoint.publicationRunId
    record.status = previousStatus === 'paused' ? 'paused' : [...this.records.values()].filter(value =>
      value.taskId !== record.taskId && ['accepted', 'running'].includes(value.status)).length < 4 ? 'accepted' : 'needs_resume'
    record.checkpoint.progressBrief = '条件已更新，旧结果不会覆盖新目标。'
    this.persist(record); this.emit(record, 'updated'); return this.get(record.taskId)
  }
  suspend(): void {
    this.suspended = true
    for (const record of this.records.values()) if (['accepted', 'running'].includes(record.status)) {
      this.invalidatePending(record, 'TASK_SUSPENDED')
      this.endRun(record, 'needs_resume'); record.status = 'needs_resume'; record.checkpoint.stopRequested = null
      record.checkpoint.progressBrief = '运行已中断，等待你继续。'; this.persist(record); this.emit(record, 'needs_resume')
    }
  }
  wake(): void { this.suspended = false }
  invalidateContext(): void {
    for (const record of this.records.values()) if (!['cancelled', 'succeeded', 'partially_succeeded', 'failed'].includes(record.status)) {
      this.invalidatePending(record, 'TASK_CONTEXT_INVALIDATED')
      this.endRun(record, 'needs_resume'); record.status = 'needs_resume'; record.checkpoint.contextVersion++
      record.checkpoint.observations = []; record.checkpoint.stopRequested = null
      record.checkpoint.progressBrief = '记忆或授权已变化，需要核对任务条件。'; this.persist(record); this.emit(record, 'needs_resume')
    }
  }
  endTemporary(sessionId: string): void {
    for (const record of this.records.values()) if (record.temporary && record.checkpoint.source.sessionId === sessionId) {
      this.invalidatePending(record, 'TEMPORARY_ENDED')
      this.endRun(record, 'cancelled'); this.records.delete(record.taskId)
    }
  }
  close(): void { this.suspend(); this.closed = true; this.listeners.clear() }
}
