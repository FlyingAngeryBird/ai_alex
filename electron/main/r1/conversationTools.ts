import { R1MemoryStore, type R1Memory } from './memory.js'
import { R1FocusTools, focusToolAliases, type FocusToolServices } from './focusTools.js'
import { R1ReminderTools, reminderToolAliases } from './reminderTools.js'
import { randomUUID, createHash } from 'node:crypto'
import type { SessionMessage } from './conversations.js'
import type { R1PromptAssets } from './promptAssets.js'
import type { R1Task, R1TaskSupervisor } from './taskSupervisor.js'
import { R1Items } from './items.js'
import { inTransaction, type R1Database } from './database.js'

export type ConversationToolScope = { source: SessionMessage; temporary: boolean; timezone: string;
  assertCurrent(): void; persistenceConfirmed: boolean; signal?: AbortSignal; sourceMessages?: SessionMessage[] }
type Delegation = { toolAliases: string[]; requiredActions: Array<{ alias: string; minimumCount: number }> }
const code = (error: unknown): string => error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)
  ? error.message : 'CONVERSATION_TOOL_FAILED'
function taskView(task: R1Task) {
  const { temporary: _temporary, budget: _budget, runId: _runId, webResult: _webResult, ...view } = task
  return view
}

/** Tools operate on the actual user turn. The model cannot supply source bodies, mode or confirmation. */
export class R1ConversationTools {
  readonly aliases = ['load_skill', 'start_task', 'get_task', 'steer_task', 'pause_task', 'resume_task', 'cancel_task', 'memory_recall', 'notes_create', ...reminderToolAliases]
  private readonly focus?: R1FocusTools
  private readonly reminders: R1ReminderTools
  private readonly calls = new Map<string, { fingerprint: string; output: Record<string, unknown> }>()
  readonly loadedSkillIds = new Set<string>(['SK01'])
  constructor(private readonly db: R1Database, private readonly assets: R1PromptAssets,
    private readonly tasks: R1TaskSupervisor, private readonly scope: ConversationToolScope,
    private readonly implementedTaskAliases: readonly string[], services?: FocusToolServices) {
    scope.assertCurrent()
    if (services) { this.aliases.push(...focusToolAliases); this.focus = new R1FocusTools(services, scope.source, scope.assertCurrent) }
    this.reminders = new R1ReminderTools(new R1Items(db), { source: { ...scope.source, timezone: scope.timezone },
      assertCurrent: scope.assertCurrent, checkSources: refs => this.checkReminderSources(refs), timeSource: refs => this.reminderSource(refs), requirePersistence: () => {
        scope.assertCurrent()
        if (scope.temporary && !scope.persistenceConfirmed) throw new Error('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
      } })
    if (scope.source.role !== 'user') throw new Error('CONVERSATION_SOURCE_INVALID')
    const source = db.prepare(`SELECT m.body, m.session_id FROM messages m JOIN sessions s ON s.session_id = m.session_id
      WHERE m.message_id = ? AND m.role = 'user' AND s.temporary = 0 AND s.status <> 'memory_source'`).get(scope.source.messageId) as {
      body: string; session_id: string
    } | undefined
    if (scope.temporary ? source !== undefined : !source || source.body !== scope.source.body || source.session_id !== scope.source.sessionId) {
      throw new Error('CONVERSATION_SOURCE_NOT_AVAILABLE')
    }
  }
  private permittedTask(id: string): R1Task {
    const task = this.tasks.list(this.scope.temporary ? this.scope.source.sessionId : null).find(task => task.taskId === id)
    if (!task) throw new Error('TASK_NOT_FOUND')
    return this.tasks.modelView(task.taskId)
  }
  private checkSources(refs: string[]): void {
    // Both IDs are actual current-turn identifiers; normalize the source to the real message ID on commit.
    if (refs.some(ref => ![this.scope.source.messageId, this.scope.source.turnId].includes(ref))) throw new Error('CONVERSATION_SOURCE_NOT_AVAILABLE')
  }
  private reminderSources(): SessionMessage[] {
    const known = [...(this.scope.sourceMessages ?? []), this.scope.source]
    return known.filter(message => message.role === 'user' && message.sessionId === this.scope.source.sessionId &&
      Date.parse(message.createdAt) <= Date.parse(this.scope.source.createdAt) &&
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
  execute(alias: string, input: unknown, callId: string): Record<string, unknown> {
    this.scope.assertCurrent(); this.assets.validateToolInput(alias, input)
    if (!this.aliases.includes(alias)) throw new Error('MODEL_TOOL_NOT_EXPOSED')
    if (!this.assets.exposeTools({ channel: 'realtime', loadedSkillIds: [...this.loadedSkillIds],
      authorizedAliases: this.aliases, temporary: this.scope.temporary }).some(tool => tool.function.name === alias)) throw new Error('MODEL_TOOL_NOT_EXPOSED')
    if (!callId || callId.length > 300) throw new Error('CONVERSATION_CALL_ID_INVALID')
    const fingerprint = createHash('sha256').update(JSON.stringify({ alias, input })).digest('hex')
    const previous = this.calls.get(callId)
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('CONVERSATION_CALL_ID_REUSED')
      return structuredClone(previous.output)
    }
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
      } else if (alias === 'memory_recall') {
        if (this.scope.temporary) throw new Error('MEMORY_UNAVAILABLE_IN_TEMPORARY_SESSION')
        const entries = new R1MemoryStore(this.db).recall(args.query as string, false, args.category as R1Memory['category'] | null ?? null)
        output = { kind: 'receipt', actionId: randomUUID(), tool: this.assets.toolDefinition(alias).name,
          status: 'succeeded', entityId: null, entityVersion: null,
          data: { matchStatus: entries.length ? 'matched' : 'no_match', memories: entries.map(({ memoryId, content, category, version, sourceRefs }) => ({ memoryId, content, category, version, sourceRefs })) },
          errorCode: null, retryable: false, runId: null }
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
      } else if (alias === 'notes_create') {
        if (this.scope.temporary && !this.scope.persistenceConfirmed) throw new Error('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
        this.checkSources(args.sourceRefs as string[])
        const actionId = randomUUID()
        output = inTransaction(this.db, () => {
          this.scope.assertCurrent()
          const items = new R1Items(this.db)
          const result = items.create({ actionId, kind: args.type as 'note' | 'todo', title: args.title as string,
            body: args.content as string, preserveBody: args.mode === 'original', sourceRefs: [this.scope.source.messageId] })
          const receipt = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name, status: 'succeeded',
            entityId: result.item.itemId, entityVersion: result.item.version, data: { item: items.toolView(result.item.itemId) },
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
          const aliases = delegation?.toolAliases ?? ['read_file', 'write_todos']
          if (aliases.some(alias => !this.implementedTaskAliases.includes(alias))) throw new Error('TASK_TOOL_IMPLEMENTATION_UNAVAILABLE')
          if (this.scope.temporary && aliases.some(alias => this.assets.toolDefinition(alias).effect === 'write') && !this.scope.persistenceConfirmed) throw new Error('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
          task = this.tasks.accept({ requestKey: `conversation:${this.scope.source.messageId}:${callId}`,
            sourceMessageId: this.scope.source.messageId, timezone: this.scope.timezone, goal: args.goal as string,
            constraints: args.constraints as string[], authorizedAliases: aliases, requiredActions: delegation?.requiredActions,
            selectedTrackKey: this.focus?.selectedTrackKey ?? null, complexity: 'complex', persistenceConfirmed: this.scope.persistenceConfirmed })
          status = task.queuePosition && task.queuePosition > 0 ? 'queued' : 'accepted'
        } else {
          const current = this.permittedTask(args.taskId as string)
          if (alias === 'get_task') {
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
            const aliases = delegation?.toolAliases ?? ['read_file', 'write_todos']
            if (aliases.some(alias => !this.implementedTaskAliases.includes(alias))) throw new Error('TASK_TOOL_IMPLEMENTATION_UNAVAILABLE')
            if (this.scope.temporary && aliases.some(alias => this.assets.toolDefinition(alias).effect === 'write') && !this.scope.persistenceConfirmed) throw new Error('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
            if (patch.removeConstraints.some(value => !current.constraints.includes(value))) throw new Error('TASK_CONSTRAINT_NOT_FOUND')
            task = this.tasks.steer({ taskId: current.taskId, expectedGoalVersion: args.expectedGoalVersion as number,
              goal: patch.goal ?? current.goal, constraints: [...new Set([...current.constraints.filter(value => !patch.removeConstraints.includes(value)), ...patch.addConstraints])],
              sourceMessageId: this.scope.source.messageId, selectedTrackKey: this.focus?.selectedTrackKey ?? null, authorizedAliases: aliases, requiredActions: delegation?.requiredActions })
            status = 'updated'
          } else if (alias === 'pause_task') {
            task = this.tasks.pause(current.taskId, args.expectedGoalVersion as number)
            status = task.status === 'running' ? 'pause_requested' : 'paused'
          } else if (alias === 'resume_task') {
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
    this.calls.set(callId, { fingerprint, output: structuredClone(output) })
    return structuredClone(output)
  }
}
