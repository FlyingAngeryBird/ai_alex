import { createHash, randomUUID } from 'node:crypto'
import { inTransaction, type R1Database } from './database.js'
import type { R1TaskInput, R1TaskAuthority } from './taskBoundary.js'
import type { R1PromptAssets } from './promptAssets.js'
import { R1Artifacts, type ArtifactDraft } from './artifacts.js'

export type TaskStatus = 'accepted' | 'running' | 'waiting_input' | 'paused' | 'needs_resume' |
  'succeeded' | 'partially_succeeded' | 'failed' | 'cancelled'
export type TaskSource = { messageId: string; sessionId: string; turnId: string; body: string;
  createdAt: string; timezone: string; temporary: boolean }
type PlanStep = { stepId: string; action: string; dependsOn: string[];
  status: 'pending' | 'running' | 'completed' | 'blocked' | 'cancelled'; successCondition: string }
type TaskCheckpoint = { version: 1; requestKey: string; requestFingerprint?: string; source: TaskSource; sourceRefs: string[];
  contextVersion: number; deletionEpoch: number; authorizedAliases: string[]; loadedSkillIds: string[];
  runId: string | null; stopRequested: 'paused' | 'cancelled' | null; planVersion: number; plan: PlanStep[];
  observations: R1TaskInput['observations']; receiptActionIds: string[]; progressBrief: string;
  actions?: Array<{ actionId: string; alias: string; runId: string }>;
  toolReceipts?: TaskToolReceipt[];
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
export type R1Task = { taskId: string; goal: string; constraints: string[]; goalVersion: number;
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
  constructor(private readonly db: R1Database, private readonly assets: R1PromptAssets,
    private readonly deletionEpoch: () => number, private readonly options: {
      clock?: () => number; temporarySource?: (messageId: string) => TaskSource | undefined
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
      this.records.set(record.taskId, record)
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
    const row = this.db.prepare(`SELECT m.message_id, m.session_id, m.turn_id, m.body, m.created_at
      FROM messages m JOIN sessions s ON s.session_id = m.session_id WHERE m.message_id = ?
      AND m.role = 'user' AND s.temporary = 0 AND s.status <> 'memory_source'`)
      .get(messageId) as { message_id: string; session_id: string; turn_id: string; body: string; created_at: string } | undefined
    if (!row) throw new Error('TASK_SOURCE_NOT_FOUND')
    if (this.db.prepare('SELECT 1 FROM source_suppression WHERE source_ref = ?').get(messageId)) throw new Error('TASK_SOURCE_SUPPRESSED')
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
      resultId: result?.resultId ?? null, result })
  }
  list(temporarySessionId: string | null = null): R1Task[] {
    return [...this.records.values()].filter(record => temporarySessionId
      ? record.temporary && record.checkpoint.source.sessionId === temporarySessionId : !record.temporary)
      .map(record => this.get(record.taskId))
  }
  onChanged(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener) }
  }
  private emit(record: RecordTask, reason: TaskEvent['reason']): void {
    const event: TaskEvent = { eventId: randomUUID(), occurredAt: new Date().toISOString(), task: this.get(record.taskId), reason }
    for (const listener of this.listeners) { try { listener(structuredClone(event)) } catch { /* committed */ } }
  }
  accept(input: { requestKey: string; sourceMessageId: string; timezone: string; goal: string;
    constraints: string[]; authorizedAliases: string[]; complexity: 'light' | 'complex' }): R1Task {
    if (this.closed) throw new Error('TASK_SERVICE_CLOSED')
    requireText(input.requestKey, 160, 'TASK_REQUEST_KEY_INVALID')
    requireText(input.sourceMessageId, 160, 'TASK_SOURCE_INVALID')
    requireText(input.goal, 2000, 'TASK_GOAL_INVALID')
    if (!Array.isArray(input.constraints) || input.constraints.length > 50) throw new Error('TASK_CONSTRAINT_INVALID')
    input.constraints.forEach(value => requireText(value, 500, 'TASK_CONSTRAINT_INVALID'))
    if (!['light', 'complex'].includes(input.complexity)) throw new Error('TASK_COMPLEXITY_INVALID')
    if (typeof input.timezone !== 'string' || !input.timezone) throw new Error('TASK_TIMEZONE_INVALID')
    try { new Intl.DateTimeFormat('zh-CN', { timeZone: input.timezone }) } catch { throw new Error('TASK_TIMEZONE_INVALID') }
    this.assets.exposeTools({ channel: 'task', loadedSkillIds: [], authorizedAliases: input.authorizedAliases, temporary: false })
    // The original request remains immutable even when the current goal/source changes.
    const fingerprint = createHash('sha256').update(JSON.stringify({ sourceMessageId: input.sourceMessageId,
      timezone: input.timezone, goal: input.goal, constraints: input.constraints,
      authorizedAliases: [...new Set(input.authorizedAliases)].sort(), complexity: input.complexity })).digest('hex')
    const existing = [...this.records.values()].find(record => record.checkpoint.requestKey === input.requestKey)
    if (existing) {
      if (!existing.checkpoint.requestFingerprint) throw new Error('TASK_REQUEST_REVALIDATION_REQUIRED')
      if (existing.checkpoint.requestFingerprint !== fingerprint) throw new Error('TASK_REQUEST_KEY_REUSED')
      return this.get(existing.taskId)
    }
    const source = this.source(input.sourceMessageId)
    source.timezone = input.timezone
    this.assets.exposeTools({ channel: 'task', loadedSkillIds: [], authorizedAliases: input.authorizedAliases, temporary: source.temporary })
    if ([...this.records.values()].filter(record => ['accepted', 'running'].includes(record.status)).length >= 4) throw new Error('TASK_QUEUE_FULL')
    const taskId = randomUUID()
    const record: RecordTask = { taskId, goal: input.goal, constraints: [...input.constraints],
      goalVersion: 1, status: 'accepted', assetReleaseId: this.assets.releaseId, temporary: source.temporary,
      createdAt: new Date().toISOString(), budget: this.assets.taskBudget(input.complexity),
      checkpoint: { version: 1, requestKey: input.requestKey, requestFingerprint: fingerprint, source, sourceRefs: [source.messageId],
        contextVersion: 1, deletionEpoch: this.deletionEpoch(), authorizedAliases: [...input.authorizedAliases], loadedSkillIds: [],
        runId: null, stopRequested: null, planVersion: 0, plan: [], observations: [{ refId: source.messageId,
          kind: 'source', version: 1, summary: JSON.stringify({ turnId: source.turnId, createdAt: source.createdAt, timezone: source.timezone }),
          resourcePath: `/task/${taskId}/source-turn.json` }], receiptActionIds: [], progressBrief: '已受理。' } }
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
    if (record.budget.decisionsRemaining < 1) throw new Error('TASK_BUDGET_EXHAUSTED')
    const input: R1TaskInput = { ...lease, status: 'running', goal: record.goal, constraints: [...record.constraints],
      sourceRefs: [...record.checkpoint.sourceRefs], currentTime: new Date().toISOString(), timezone: record.checkpoint.source.timezone,
      temporary: record.temporary, budget: structuredClone(record.budget), validReceiptActionIds: [...record.checkpoint.receiptActionIds],
      observations: structuredClone(record.checkpoint.observations), loadedSkillIds: [...record.checkpoint.loadedSkillIds] }
    this.assets.validateStructured('task-input', input)
    record.budget.decisionsRemaining--; this.persist(record)
    return input
  }
  consumeTool(lease: TaskLease, alias: string): string {
    this.assertLease(lease)
    const record = this.checked(lease.taskId)
    if (record.budget.toolsRemaining < 1) throw new Error('TASK_TOOL_BUDGET_EXHAUSTED')
    if (!record.checkpoint.authorizedAliases.includes(alias)) throw new Error('TASK_TOOL_NOT_AUTHORIZED')
    if (!this.assets.exposeTools({ channel: 'task', loadedSkillIds: record.checkpoint.loadedSkillIds,
      authorizedAliases: record.checkpoint.authorizedAliases, temporary: record.temporary })
      .some(tool => tool.function.name === alias)) throw new Error('MODEL_TOOL_NOT_EXPOSED')
    const actionId = randomUUID()
    record.checkpoint.actions ??= []
    if (record.checkpoint.actions.length >= 50) throw new Error('TASK_ACTION_LIMIT')
    record.checkpoint.actions.push({ actionId, alias, runId: lease.runId })
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
    const draft = value as TaskDraft
    if (draft.goalVersion !== record.goalVersion) throw new Error('TASK_CONTEXT_STALE')
    if (draft.status === 'completed' && draft.unresolved.length) throw new Error('TASK_COMPLETION_INCONSISTENT')
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
      const temporaryReceipt = record.temporary ? record.checkpoint.toolReceipts?.find(receipt => receipt.actionId === actionId) : undefined
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
    if (draft.status === 'completed' && record.checkpoint.receiptActionIds.some(id => !draft.receiptActionIds.includes(id))) {
      throw new Error('TASK_RESULT_RECEIPT_OMITTED')
    }
    const baseIds = draft.artifacts.map(artifact => artifact.baseArtifactId).filter(id => id !== null)
    if (new Set(baseIds).size !== baseIds.length) throw new Error('TASK_ARTIFACT_BASE_REUSED')
    for (const artifact of draft.artifacts) if (artifact.baseArtifactId !== null) {
      const permitted = record.checkpoint.observations.find(observation => observation.kind === 'artifact' &&
        observation.refId === artifact.baseArtifactId && observation.version === artifact.baseArtifactVersion)
      if (!permitted || artifacts.get(artifact.baseArtifactId, record.temporary ? record.checkpoint.source.sessionId : null).version !== artifact.baseArtifactVersion) {
        throw new Error('VERSION_CONFLICT')
      }
    } else if (artifact.baseArtifactVersion !== null) throw new Error('TASK_ARTIFACT_BASE_INVALID')
    const publish = (): TaskResult => {
      this.assertLease(lease)
      const published = draft.artifacts.map(draft => {
        const owner = record.temporary ? record.checkpoint.source.sessionId : null
        const artifact = draft.baseArtifactId ? artifacts.revise({ artifactId: draft.baseArtifactId,
          expectedVersion: draft.baseArtifactVersion!, content: draft.content, title: draft.title, temporaryOwner: owner })
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
    this.endRun(record, 'cancelled'); record.status = 'cancelled'; record.checkpoint.stopRequested = 'cancelled'
    record.checkpoint.progressBrief = '已取消；已提交的事项和提醒仍保留。'
    this.persist(record); this.emit(record, 'cancelled'); return this.get(taskId)
  }
  resume(taskId: string, expectedGoalVersion: number): R1Task {
    const record = this.checked(taskId, expectedGoalVersion)
    if (this.suspended) throw new Error('TASK_DEVICE_SUSPENDED')
    if (!['paused', 'needs_resume', 'waiting_input'].includes(record.status)) throw new Error('TASK_INVALID_STATE')
    this.source(record.checkpoint.source.messageId)
    if (record.assetReleaseId !== this.assets.releaseId) throw new Error('TASK_ASSET_RELEASE_UNAVAILABLE')
    if (record.checkpoint.deletionEpoch !== this.deletionEpoch()) throw new Error('TASK_CONTEXT_REVALIDATION_REQUIRED')
    if (record.budget.decisionsRemaining < 1 || record.budget.activeMsRemaining < 1) throw new Error('TASK_BUDGET_EXHAUSTED')
    if ([...this.records.values()].filter(value => ['accepted', 'running'].includes(value.status)).length >= 4) throw new Error('TASK_QUEUE_FULL')
    record.status = 'accepted'; record.checkpoint.runId = null; record.checkpoint.stopRequested = null
    record.checkpoint.progressBrief = '准备继续，先核对已提交的步骤。'
    this.persist(record); this.emit(record, 'accepted'); return this.get(taskId)
  }
  steer(input: { taskId: string; expectedGoalVersion: number; goal: string; constraints: string[]; sourceMessageId: string }): R1Task {
    const record = this.checked(input.taskId, input.expectedGoalVersion)
    if (['succeeded', 'failed', 'cancelled'].includes(record.status)) throw new Error('TASK_INVALID_STATE')
    const source = this.source(input.sourceMessageId)
    if (source.temporary !== record.temporary || (record.temporary && source.sessionId !== record.checkpoint.source.sessionId)) {
      throw new Error('TASK_SOURCE_SCOPE_INVALID')
    }
    requireText(input.goal, 2000, 'TASK_GOAL_INVALID')
    if (!Array.isArray(input.constraints) || input.constraints.length > 50) throw new Error('TASK_CONSTRAINT_INVALID')
    input.constraints.forEach(value => requireText(value, 500, 'TASK_CONSTRAINT_INVALID'))
    const previousStatus = record.status
    this.endRun(record, 'superseded')
    record.goal = input.goal; record.constraints = [...input.constraints]; record.goalVersion++
    record.checkpoint.contextVersion++; record.checkpoint.deletionEpoch = this.deletionEpoch()
    source.timezone = record.checkpoint.source.timezone; record.checkpoint.source = source
    record.checkpoint.sourceRefs = [source.messageId]; record.checkpoint.observations = [{ refId: source.messageId,
      kind: 'source', version: 1, summary: JSON.stringify({ turnId: source.turnId, createdAt: source.createdAt, timezone: source.timezone }),
      resourcePath: `/task/${record.taskId}/source-turn.json` }]
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
      this.endRun(record, 'needs_resume'); record.status = 'needs_resume'; record.checkpoint.stopRequested = null
      record.checkpoint.progressBrief = '运行已中断，等待你继续。'; this.persist(record); this.emit(record, 'needs_resume')
    }
  }
  wake(): void { this.suspended = false }
  invalidateContext(): void {
    for (const record of this.records.values()) if (!['cancelled', 'succeeded', 'partially_succeeded', 'failed'].includes(record.status)) {
      this.endRun(record, 'needs_resume'); record.status = 'needs_resume'; record.checkpoint.contextVersion++
      record.checkpoint.observations = []; record.checkpoint.stopRequested = null
      record.checkpoint.progressBrief = '记忆或授权已变化，需要核对任务条件。'; this.persist(record); this.emit(record, 'needs_resume')
    }
  }
  endTemporary(sessionId: string): void {
    for (const record of this.records.values()) if (record.temporary && record.checkpoint.source.sessionId === sessionId) {
      this.endRun(record, 'cancelled'); this.records.delete(record.taskId)
    }
  }
  close(): void { this.suspend(); this.closed = true; this.listeners.clear() }
}
