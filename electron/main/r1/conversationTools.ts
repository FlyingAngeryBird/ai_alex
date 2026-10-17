import { R1MemoryStore } from './memory.js'
import { R1Topics } from './topics.js'
import { R1MemoryTools, memoryToolAliases, isSensitiveMemory, type MemorySaveCandidate } from './memoryTools.js'
import type { MemoryConfirmation } from './memoryConfirmations.js'
import { memoryContextCutoff } from './memoryContext.js'
import { R1FocusTools, focusToolAliases, type FocusToolServices } from './focusTools.js'
import { R1ReminderTools, reminderToolAliases } from './reminderTools.js'
import { randomUUID, createHash } from 'node:crypto'
import type { SessionMessage } from './conversations.js'
import type { R1PromptAssets } from './promptAssets.js'
import type { R1Task, R1TaskSupervisor } from './taskSupervisor.js'
import { R1Items } from './items.js'
import { R1Artifacts } from './artifacts.js'
import { bindArtifactEdit, type ArtifactEditingContext, type ArtifactEditProposal } from './artifactContext.js'
import { currentCandidateContext, type CandidateContext } from './sessionMode.js'
import { candidateSaveActionId } from './taskSupervisor.js'
import { isDeepStrictEqual } from 'node:util'
import { R1ItemTools, itemMutationAliases, itemActionAliases } from './itemTools.js'
import type { ItemActionView } from './itemActions.js'
import { musicAliases, type R1Music } from './music.js'
import { R1MusicTools } from './musicTools.js'
import { afterTransactionCommit, inTransaction, type R1Database } from './database.js'

export type ConversationToolScope = { source: SessionMessage; temporary: boolean; timezone: string;
  realtimeSimpleSearch?: boolean; ownerId?: number;
  assertCurrent(): void; persistenceConfirmed: boolean; signal?: AbortSignal; sourceMessages?: SessionMessage[];
  requestItemAction?(input: { kind: 'delete'; itemId: string; expectedVersion: number } |
    { kind: 'export'; itemIds: string[]; artifactId: null; artifactVersion: null; format: 'txt' | 'md' } |
    { kind: 'export'; itemIds: []; artifactId: string; artifactVersion: number; format: 'txt' | 'md' }): ItemActionView;
  selectedArtifact?: ArtifactEditingContext | null;
  selectedCandidate?: CandidateContext | null;
  onMemoryInvalidated?(deletionEpoch: number): void;
  requestMemoryConfirmation?(candidate: MemorySaveCandidate, sensitive: boolean): MemoryConfirmation }
type Delegation = { toolAliases: string[]; requiredActions: Array<{ alias: string; minimumCount: number }> }
const code = (error: unknown): string => error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)
  ? error.message : 'CONVERSATION_TOOL_FAILED'
function taskView(task: R1Task) {
  const { temporary: _temporary, budget: _budget, runId: _runId, webResult: _webResult, ...view } = task
  return view
}

/** Tools operate on the actual user turn. The model cannot supply source bodies, mode or confirmation. */
export class R1ConversationTools {
  readonly aliases = ['load_skill', 'start_task', 'get_task', 'steer_task', 'pause_task', 'resume_task', 'cancel_task', ...memoryToolAliases, 'notes_create', ...itemMutationAliases, ...itemActionAliases, ...reminderToolAliases]
  memoryMutationReceipt: Record<string, unknown> | null = null
  memoryConfirmation: MemoryConfirmation | null = null
  private readonly memories: R1MemoryTools
  private readonly focus?: R1FocusTools
  private readonly music?: R1MusicTools
  private readonly musicService?: R1Music
  private readonly pendingCalls = new Map<string, { fingerprint: string; promise: Promise<Record<string, unknown>> }>()
  private readonly reminders: R1ReminderTools
  private readonly itemTools: R1ItemTools
  private readonly calls = new Map<string, { fingerprint: string; output: Record<string, unknown> }>()
  readonly loadedSkillIds = new Set<string>(['SK01'])
  constructor(private readonly db: R1Database, private readonly assets: R1PromptAssets,
    private readonly tasks: R1TaskSupervisor, private readonly scope: ConversationToolScope,
    private readonly implementedTaskAliases: readonly string[], services?: FocusToolServices, private readonly artifacts: R1Artifacts = new R1Artifacts(db), music?: R1Music) {
    scope.assertCurrent()
    this.itemTools = new R1ItemTools(new R1Items(db), { assertCurrent: scope.assertCurrent, requirePersistence() {
      if (scope.temporary && !scope.persistenceConfirmed) throw new Error('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
    } })
    const recallProperties = assets.toolDefinition('memory_recall').output_data_schema.properties as Record<string, unknown> | undefined
    this.memories = new R1MemoryTools(new R1MemoryStore(db, assets.memoryRecallPolicy()), scope.source, recallProperties && Object.hasOwn(recallProperties, 'topics') ? new R1Topics(db) : undefined)
    if (services) { this.aliases.push(...focusToolAliases); this.focus = new R1FocusTools(services, scope.source, scope.assertCurrent) }
    if (music) { this.musicService = music; this.aliases.push(...musicAliases); this.music = new R1MusicTools(music, { ...scope, sourceRef: scope.source.messageId }) }
    this.reminders = new R1ReminderTools(new R1Items(db), { source: { ...scope.source, timezone: scope.timezone },
      assertCurrent: scope.assertCurrent, checkSources: refs => this.checkReminderSources(refs), timeSource: refs => this.reminderSource(refs), requirePersistence: () => {
        scope.assertCurrent()
        if (scope.temporary && !scope.persistenceConfirmed) throw new Error('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
      } })
    if (scope.source.role !== 'user') throw new Error('CONVERSATION_SOURCE_INVALID')
    const source = db.prepare(`SELECT m.rowid AS sequence, m.body, m.session_id FROM messages m JOIN sessions s ON s.session_id = m.session_id
      WHERE m.message_id = ? AND m.role = 'user' AND s.temporary = 0 AND s.status <> 'memory_source'`).get(scope.source.messageId) as {
      sequence: number; body: string; session_id: string
    } | undefined
    if (scope.temporary ? source !== undefined : !source || source.sequence <= memoryContextCutoff(db) || source.body !== scope.source.body || source.session_id !== scope.source.sessionId) {
      throw new Error('CONVERSATION_SOURCE_NOT_AVAILABLE')
    }
  }
  private permittedTask(id: string): R1Task {
    const task = this.tasks.list(this.scope.temporary ? this.scope.source.sessionId : null).find(task => task.taskId === id)
    if (!task) throw new Error('TASK_NOT_FOUND')
    return this.tasks.modelView(task.taskId)
  }
  private artifactEdit(value: unknown) {
    return value == null ? null : bindArtifactEdit(this.scope.selectedArtifact, value as ArtifactEditProposal, this.artifacts,
      this.scope.temporary ? this.scope.source.sessionId : null)
  }
  private checkSources(refs: string[]): void {
    // Both IDs are actual current-turn identifiers; normalize the source to the real message ID on commit.
    if (refs.some(ref => ![this.scope.source.messageId, this.scope.source.turnId].includes(ref))) throw new Error('CONVERSATION_SOURCE_NOT_AVAILABLE')
  }
  private reminderSources(): SessionMessage[] {
    const known = [...(this.scope.sourceMessages ?? []), this.scope.source]
    const cutoff = memoryContextCutoff(this.db)
    return known.filter(message => message.role === 'user' && message.sessionId === this.scope.source.sessionId &&
      Date.parse(message.createdAt) <= Date.parse(this.scope.source.createdAt) &&
      (this.scope.temporary || Boolean(this.db.prepare('SELECT 1 FROM messages WHERE message_id = ? AND rowid > ?').get(message.messageId, cutoff))) &&
      !this.db.prepare('SELECT 1 FROM source_suppression WHERE source_ref IN (?, ?)').get(message.messageId, message.turnId))
  }
  private checkReminderSources(refs: string[]): void {
    const known = this.reminderSources()
    if (refs.some(ref => !known.some(message => [message.messageId, message.turnId].includes(ref)))) throw new Error('CONVERSATION_SOURCE_NOT_AVAILABLE')
  }
  private reminderSource(refs: string[] = []) {
    this.checkReminderSources(refs)
    const current = this.scope.source
    if (/今天|今晚|明天|明晚|后天|后晚|(?:秒|分|小时|钟头).*后/.test(current.body)) return { ...current, timezone: this.scope.timezone }
    const previous = this.reminderSources().filter(message => refs.some(ref => [message.messageId, message.turnId].includes(ref)))
      .filter(message => /今天|今晚|明天|明晚|后天|后晚/.test(message.body)).at(-1)
    const day = previous?.body.match(/今天|今晚|明天|明晚|后天|后晚/)?.[0]
    return { ...current, body: day ? `${day} ${current.body}` : current.body,
      createdAt: previous?.createdAt ?? current.createdAt, timezone: this.scope.timezone }
  }
  async executeAsync(alias: string, input: unknown, callId: string): Promise<Record<string, unknown>> {
    if (!(musicAliases as readonly string[]).includes(alias)) return this.execute(alias, input, callId)
    const fingerprint = this.validateCall(alias, input, callId), prior = this.calls.get(callId)
    if (prior) return structuredClone(prior.output)
    const pending = this.pendingCalls.get(callId)
    if (pending) { if (pending.fingerprint !== fingerprint) throw new Error('CONVERSATION_CALL_ID_REUSED'); return pending.promise }
    const actionId = randomUUID(), args = input as Record<string, unknown>
    const promise = (async () => {
      let receipt: Record<string, unknown>
      let mediaConfirmed = false
      try {
        const local = ['music_get_state', 'music_queue', 'music_favorite', 'music_feedback'].includes(alias)
        const build = (data: Record<string, unknown>) => ({ kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name,
          status: 'succeeded', entityId: alias === 'music_feedback' ? data.feedbackId : (data.state as { track?: { trackKey?: string } } | undefined)?.track?.trackKey ?? args.trackKey ?? null,
          entityVersion: (data.state as { playerVersion?: number } | undefined)?.playerVersion ?? null, data, errorCode: null, retryable: false, runId: null })
        if (local) receipt = inTransaction(this.db, () => { this.scope.assertCurrent(); const value = build(this.music!.local(alias, args)); this.assets.validateToolOutput(alias, value); this.saveMusicReceipt(value); return value })
        else {
          receipt = build(await this.music!.execute(alias, args)); mediaConfirmed = true
          this.assets.validateToolOutput(alias, receipt)
          // Cache the observed outcome before durable I/O, so a storage failure cannot repeat audio.
          this.calls.set(callId, { fingerprint, output: structuredClone(receipt) })
          this.saveMusicReceipt(receipt)
        }
      } catch (error) {
        if (mediaConfirmed) throw new Error('MUSIC_RECEIPT_PERSIST_FAILED')
        const errorCode = code(error)
        receipt = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name,
          status: errorCode === 'MUSIC_PLAYBACK_UNKNOWN' ? 'unknown' : ['MUSIC_SUPERSEDED', 'SESSION_CHANGED', 'RESPONSE_STOPPED'].includes(errorCode) ? 'cancelled' : 'failed',
          entityId: null, entityVersion: null, data: {}, errorCode, retryable: false, runId: null }
        this.assets.validateToolOutput(alias, receipt); this.saveMusicReceipt(receipt)
      }
      this.calls.set(callId, { fingerprint, output: structuredClone(receipt) })
      this.scope.assertCurrent(); return receipt
    })().finally(() => { this.pendingCalls.delete(callId) })
    this.pendingCalls.set(callId, { fingerprint, promise }); return this.musicService!.trackExecution(promise)
  }
  private saveMusicReceipt(receipt: Record<string, unknown>): void {
    if (this.scope.temporary) return
    this.db.prepare('INSERT OR IGNORE INTO receipts(action_id,entity_id,entity_version,status,actual_result_json,created_at) VALUES (?,?,?,?,?,?)')
      .run(receipt.actionId as string, receipt.entityId as string | null, receipt.entityVersion as number | null, receipt.status as string, JSON.stringify(receipt), new Date().toISOString())
  }
  private validateCall(alias: string, input: unknown, callId: string): string {
    this.scope.assertCurrent(); this.assets.validateToolInput(alias, input)
    if (!this.aliases.includes(alias)) throw new Error('MODEL_TOOL_NOT_EXPOSED')
    if (!this.assets.exposeTools({ channel: 'realtime', loadedSkillIds: [...this.loadedSkillIds],
      authorizedAliases: this.aliases, temporary: this.scope.temporary }).some(tool => tool.function.name === alias)) throw new Error('MODEL_TOOL_NOT_EXPOSED')
    if (!callId || callId.length > 300) throw new Error('CONVERSATION_CALL_ID_INVALID')
    const fingerprint = createHash('sha256').update(JSON.stringify({ alias, input })).digest('hex')
    const previous = this.calls.get(callId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('CONVERSATION_CALL_ID_REUSED')
    }
    return fingerprint
  }
  execute(alias: string, input: unknown, callId: string): Record<string, unknown> {
    const fingerprint = this.validateCall(alias, input, callId), previous = this.calls.get(callId)
    if (previous) return structuredClone(previous.output)
    if (this.memoryMutationReceipt) throw new Error('MEMORY_CONTEXT_REVOKED')
    const args = input as Record<string, unknown>
    let output: Record<string, unknown>
    try {
      if (alias === 'load_skill') {
        const skill = this.assets.loadSkill(args.skillId as string)
        output = { kind: 'receipt', actionId: randomUUID(), tool: this.assets.toolDefinition(alias).name,
          status: 'succeeded', entityId: null, entityVersion: null, data: skill,
          errorCode: null, retryable: false, runId: null }
        this.assets.validateToolOutput(alias, output)
        this.loadedSkillIds.add(args.skillId as string)
      } else if ((memoryToolAliases as readonly string[]).includes(alias)) {
        if (alias === 'memory_remember' || alias === 'memory_update') {
          const candidate = this.memories.prepare(alias, args)
          const sensitive = isSensitiveMemory(this.scope.source.body, candidate.content)
          if (this.scope.temporary || sensitive) {
            if (!this.scope.requestMemoryConfirmation) throw new Error(this.scope.temporary ? 'MEMORY_TEMPORARY_EXIT_UNAVAILABLE' : 'MEMORY_SENSITIVE_CONFIRMATION_REQUIRED')
            const pending = this.scope.requestMemoryConfirmation(candidate, sensitive)
            output = { kind: 'ui_action', uiActionId: pending.confirmationId, status: 'awaiting_user', action: 'confirm_memory', data: {} }
            this.assets.validateToolOutput(alias, output)
            this.memoryConfirmation = pending
            this.calls.set(callId, { fingerprint, output: structuredClone(output) })
            return output
          }
        }
        if (this.scope.temporary) throw new Error('MEMORY_UNAVAILABLE_IN_TEMPORARY_SESSION')
        if (['memory_update', 'memory_forget'].includes(alias) && !this.scope.onMemoryInvalidated) throw new Error('MEMORY_CONTEXT_REFRESH_UNAVAILABLE')
        output = inTransaction(this.db, () => {
          this.scope.assertCurrent()
          const result = this.memories.execute(alias, args)
          const receipt = { kind: 'receipt', actionId: randomUUID(), tool: this.assets.toolDefinition(alias).name,
            status: 'succeeded', entityId: result.entityId ?? null, entityVersion: result.entityVersion ?? null,
            data: result.data, errorCode: null, retryable: false, runId: null }
          this.assets.validateToolOutput(alias, receipt)
          if (result.invalidatedEpoch !== undefined) {
            // Only our synchronous mutation may refresh its owner; every other request keeps its old epoch.
            afterTransactionCommit(this.db, () => {
              this.memoryMutationReceipt = receipt
              this.scope.onMemoryInvalidated!(result.invalidatedEpoch!)
            })
          } else this.scope.assertCurrent()
          return receipt
        })
      } else if ((focusToolAliases as readonly string[]).includes(alias)) {
        output = inTransaction(this.db, () => {
          const actionId = randomUUID(), result = this.focus!.execute(alias, args, actionId)
          const receipt = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name, status: 'succeeded',
            entityId: result.entityId ?? null, entityVersion: result.entityVersion ?? null, data: result.data,
            errorCode: null, retryable: false, runId: null }
          this.assets.validateToolOutput(alias, receipt); this.scope.assertCurrent()
          return receipt
        })
      } else if ((reminderToolAliases as readonly string[]).includes(alias)) {
        output = inTransaction(this.db, () => {
          this.scope.assertCurrent()
          const actionId = randomUUID(), result = this.reminders.execute(alias, args, actionId)
          const receipt = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name, status: 'succeeded',
            entityId: result.entityId ?? null, entityVersion: result.entityVersion ?? null, data: result.data,
            errorCode: null, retryable: false, runId: null }
          this.assets.validateToolOutput(alias, receipt); this.scope.assertCurrent()
          return receipt
        })
      } else if ((itemActionAliases as readonly string[]).includes(alias)) {
        // Model-initiated delete/export only prepares a trusted renderer action;
        // disposition, reminder choice and file path never come from the model.
        if (!this.scope.requestItemAction || !this.scope.ownerId) throw new Error('ITEM_ACTION_UNAVAILABLE')
        const context = { ownerId: this.scope.ownerId, sessionId: this.scope.source.sessionId,
          temporary: this.scope.temporary, assertCurrent: this.scope.assertCurrent }
        if (alias === 'notes_delete') {
          const itemId = args.itemId as string, expectedVersion = args.expectedVersion as number
          this.itemTools.observedView(itemId, expectedVersion)
          const view = this.scope.requestItemAction({ kind: 'delete', itemId, expectedVersion })
          output = { kind: 'ui_action', uiActionId: view.ticket, status: 'awaiting_user',
            action: 'confirm_item_delete', data: view.data }
        } else {
          if (args.itemIds) for (const itemId of args.itemIds as string[]) this.itemTools.observed(itemId)
          const view = (args.itemIds as string[]).length
            ? this.scope.requestItemAction({ kind: 'export', itemIds: args.itemIds as string[],
              artifactId: null, artifactVersion: null, format: args.format as 'txt' | 'md' })
            : this.scope.requestItemAction({ kind: 'export', itemIds: [],
              artifactId: args.artifactId as string, artifactVersion: args.artifactVersion as number,
              format: args.format as 'txt' | 'md' })
          output = { kind: 'ui_action', uiActionId: view.ticket, status: 'awaiting_user',
            action: 'export', data: view.data }
        }
      } else if ((itemMutationAliases as readonly string[]).includes(alias)) {
        output = inTransaction(this.db, () => {
          const actionId = randomUUID(), result = this.itemTools.execute(alias, args, actionId)
          const receipt = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name, status: 'succeeded',
            entityId: result.entityId, entityVersion: result.entityVersion, data: result.data,
            errorCode: null, retryable: false, runId: null }
          this.assets.validateToolOutput(alias, receipt); this.scope.assertCurrent()
          return receipt
        })
      } else if (alias === 'notes_create') {
        if (this.scope.temporary && !this.scope.persistenceConfirmed) throw new Error('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
        const target = args.candidateTarget as { taskId: string; goalVersion: number; candidateId: string; candidateVersion: number } | null | undefined
        const selected = this.scope.selectedCandidate
        if (target) {
          if (!selected || ['taskId', 'goalVersion', 'candidateId', 'candidateVersion'].some(key =>
            target[key as keyof typeof target] !== selected[key as keyof typeof target])) throw new Error('CANDIDATE_SELECTION_MISMATCH')
          const current = currentCandidateContext({ temporary: this.scope.temporary, sessionId: this.scope.source.sessionId, selectedCandidate: target }, this.tasks)
          if (!current || !isDeepStrictEqual(current, selected)) throw new Error('CANDIDATE_CONTEXT_STALE')
          if (args.type !== 'note' || args.mode !== 'original') throw new Error('CANDIDATE_SAVE_MODE_INVALID')
          if ((args.sourceRefs as string[]).some(ref => ![this.scope.source.messageId, this.scope.source.turnId, ...selected.candidate.sourceRefs].includes(ref))) throw new Error('CONVERSATION_SOURCE_NOT_AVAILABLE')
        } else this.checkSources(args.sourceRefs as string[])
        const actionId = target ? candidateSaveActionId(target.taskId, target.candidateId) : randomUUID()
        output = inTransaction(this.db, () => {
          this.scope.assertCurrent()
          const items = new R1Items(this.db)
          const saved = target ? this.tasks.saveCandidate({ taskId: target.taskId, expectedGoalVersion: target.goalVersion,
            candidateId: target.candidateId, title: args.title as string, temporarySaveConfirmed: this.scope.persistenceConfirmed }) : null
          const itemId = saved?.itemId ?? items.create({ actionId, kind: args.type as 'note' | 'todo', title: args.title as string,
            body: args.content as string, preserveBody: args.mode === 'original', sourceRefs: [this.scope.source.messageId] }).item.itemId
          const item = items.toolView(itemId)
          const receipt = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name, status: 'succeeded',
            entityId: item.itemId, entityVersion: item.version, data: { item },
            errorCode: null, retryable: false, runId: null }
          this.assets.validateToolOutput(alias, receipt); this.scope.assertCurrent()
          return receipt
        })
      } else {
        let task: R1Task
        let status: string
        if (alias === 'start_task') {
          this.checkSources(args.sourceRefs as string[])
          const delegation = args.delegation as Delegation | undefined
          if (this.scope.realtimeSimpleSearch && delegation?.toolAliases.some(alias => ['web_search', 'web_read_page'].includes(alias))) throw new Error('REALTIME_SEARCH_USE_IMMEDIATE_TOOLS')
          // Skill/source reading is the existing sandboxed task scaffold. A
          // domain-only delegation must not hide the only way to load its Skill.
          const aliases = [...new Set(['read_file', ...(delegation?.toolAliases ?? ['write_todos'])])]
          if (aliases.some(alias => !this.implementedTaskAliases.includes(alias))) throw new Error('TASK_TOOL_IMPLEMENTATION_UNAVAILABLE')
          if (this.scope.temporary && aliases.some(alias => this.assets.toolDefinition(alias).effect === 'write') && !this.scope.persistenceConfirmed) throw new Error('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
          task = this.tasks.accept({ requestKey: `conversation:${this.scope.source.messageId}:${callId}`,
            sourceMessageId: this.scope.source.messageId, timezone: this.scope.timezone, goal: args.goal as string,
            constraints: args.constraints as string[], authorizedAliases: aliases, requiredActions: delegation?.requiredActions,
            artifactEdit: this.artifactEdit(args.artifactTarget),
            selectedTrackKey: this.focus?.selectedTrackKey ?? null, complexity: 'complex', persistenceConfirmed: this.scope.persistenceConfirmed,
            ownerId: this.scope.ownerId })
          status = task.queuePosition && task.queuePosition > 0 ? 'queued' : 'accepted'
        } else {
          const current = this.permittedTask(args.taskId as string)
          if (alias === 'get_task') {
            // Old app versions could publish web conclusions with no evidence.
            // Do not feed such legacy results back to M01 as verified success.
            if (current.status === 'succeeded' && current.result) {
              const required = this.tasks.authority(current.taskId).authorizedAliases.filter(value => ['web_search', 'web_read_page'].includes(value))
              if (required.some(value => !current.result!.entityReceipts.some(receipt =>
                receipt.tool === this.assets.toolDefinition(value).name && receipt.status === 'succeeded'))) {
                throw new Error('TASK_COMPLETION_WEB_EVIDENCE_MISSING')
              }
            }
            output = { kind: 'receipt', actionId: randomUUID(), tool: this.assets.toolDefinition(alias).name,
              status: 'succeeded', entityId: current.taskId, entityVersion: current.goalVersion, data: { task: taskView(current) },
              errorCode: null, retryable: false, runId: null }
            this.assets.validateToolOutput(alias, output)
            this.calls.set(callId, { fingerprint, output: structuredClone(output) }); return output
          }
          if (alias === 'steer_task') {
            this.checkSources(args.sourceRefs as string[])
            const patch = args.patch as { goal: string | null; addConstraints: string[]; removeConstraints: string[] }
            if (!this.tasks.contextIsCurrent(current.taskId) && patch.goal === null) throw new Error('TASK_CONTEXT_REVALIDATION_REQUIRED')
            const delegation = args.delegation as Delegation | undefined
            if (this.scope.realtimeSimpleSearch && (delegation?.toolAliases.some(alias => ['web_search', 'web_read_page'].includes(alias)) || this.tasks.authority(current.taskId).authorizedAliases.some(alias => ['web_search', 'web_read_page'].includes(alias)))) throw new Error('REALTIME_SEARCH_USE_IMMEDIATE_TOOLS')
            const aliases = [...new Set(['read_file', ...(delegation?.toolAliases ?? ['write_todos'])])]
            if (aliases.some(alias => !this.implementedTaskAliases.includes(alias))) throw new Error('TASK_TOOL_IMPLEMENTATION_UNAVAILABLE')
            if (this.scope.temporary && aliases.some(alias => this.assets.toolDefinition(alias).effect === 'write') && !this.scope.persistenceConfirmed) throw new Error('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
            if (patch.removeConstraints.some(value => !current.constraints.includes(value))) throw new Error('TASK_CONSTRAINT_NOT_FOUND')
            task = this.tasks.steer({ taskId: current.taskId, expectedGoalVersion: args.expectedGoalVersion as number,
              goal: patch.goal ?? current.goal, constraints: [...new Set([...current.constraints.filter(value => !patch.removeConstraints.includes(value)), ...patch.addConstraints])],
              sourceMessageId: this.scope.source.messageId, selectedTrackKey: this.focus?.selectedTrackKey ?? null, authorizedAliases: aliases, requiredActions: delegation?.requiredActions,
              artifactEdit: this.artifactEdit(args.artifactTarget) })
            status = 'updated'
          } else if (alias === 'pause_task') {
            task = this.tasks.pause(current.taskId, args.expectedGoalVersion as number)
            status = task.status === 'running' ? 'pause_requested' : 'paused'
          } else if (alias === 'resume_task') {
            if (this.scope.realtimeSimpleSearch && this.tasks.authority(current.taskId).authorizedAliases.some(alias => ['web_search', 'web_read_page'].includes(alias))) throw new Error('REALTIME_SEARCH_USE_IMMEDIATE_TOOLS')
            task = this.tasks.resume(current.taskId, args.expectedGoalVersion as number)
            status = task.queuePosition && task.queuePosition > 0 ? 'queued' : 'accepted'
          } else {
            task = this.tasks.cancel(current.taskId, args.expectedGoalVersion as number); status = 'cancelled'
          }
        }
        output = { kind: 'task_control', taskId: task.taskId, status, goalVersion: task.goalVersion,
          queuePosition: task.queuePosition, data: { task: taskView(task) }, errorCode: null }
      }
    } catch (error) {
      this.scope.assertCurrent()
      output = alias.includes('task') && alias !== 'get_task'
        ? { kind: 'task_control', taskId: '', status: 'failed', goalVersion: 1, queuePosition: null, data: {}, errorCode: code(error) }
        : { kind: 'receipt', actionId: randomUUID(), tool: this.assets.toolDefinition(alias).name, status: 'failed',
          entityId: null, entityVersion: null, data: {}, errorCode: code(error), retryable: false, runId: null }
    }
    this.assets.validateToolOutput(alias, output)
    this.reminders.observe(output)
    this.itemTools.observe(output)
    this.calls.set(callId, { fingerprint, output: structuredClone(output) })
    return structuredClone(output)
  }
}
