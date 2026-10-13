import type { ChatMessage } from '../providers/llmProvider.js'
import { createHash } from 'node:crypto'
import type { ArkModelBoundary } from '../providers/arkResponsesProvider.js'
import type { R1Persona } from './persona.js'
import type { R1ModelTool, R1PromptAssets } from './promptAssets.js'

export type R1TaskInput = {
  taskId: string; runId: string; goalVersion: number; contextVersion: number; deletionEpoch: number
  status: 'running' | 'paused' | 'cancelled' | 'needs_resume'; goal: string; constraints: string[]
  sourceRefs: string[]; currentTime: string; timezone: string; temporary: boolean
  budget: { decisionsRemaining: number; toolsRemaining: number; activeMsRemaining: number;
    searchQueriesRemaining: number; pagesRemaining: number }
  validReceiptActionIds: string[]
  observations: Array<{ refId: string; kind: 'source' | 'candidate' | 'artifact' | 'item' | 'receipt';
    version: number; summary: string; resourcePath: string | null }>
  loadedSkillIds: string[]
}
export type R1TaskAuthority = Pick<R1TaskInput, 'taskId' | 'runId' | 'goalVersion' | 'contextVersion' |
  'deletionEpoch' | 'temporary' | 'status'> & { authorizedAliases: string[]; activeMsRemaining: number }

/** M02 has PR04 and a current task authority, never the realtime PR03 role. */
export class R1TaskRequestBoundary implements ArkModelBoundary {
  readonly systemText: string
  readonly diagnostic: Readonly<{ assetReleaseId: string; promptHash: string;
    promptIds: readonly string[]; toolAliases: readonly string[]; taskId: string; runId: string; goalVersion: number }>
  private readonly tools: R1ModelTool[]
  private readonly snapshot: R1TaskInput
  private readonly authorizedAliases: string[]
  get outputFormat(): { name: string; schema: Record<string, unknown> } {
    return { name: 'seamo_task_draft_v2', schema: this.assets.structuredSchema('task-draft') }
  }
  constructor(private readonly assets: R1PromptAssets, persona: R1Persona, input: R1TaskInput,
    authorizedAliases: string[], private readonly current: () => R1TaskAuthority, steering?: Record<string, unknown>) {
    this.snapshot = structuredClone(input)
    this.authorizedAliases = [...authorizedAliases]
    assets.validateStructured('task-input', this.snapshot)
    if (input.status !== 'running') throw new Error('TASK_NOT_RUNNING')
    if (input.budget.decisionsRemaining < 1 || input.budget.activeMsRemaining < 1) throw new Error('TASK_BUDGET_EXHAUSTED')
    this.tools = assets.exposeTools({ channel: 'task', loadedSkillIds: this.snapshot.loadedSkillIds,
      authorizedAliases, temporary: this.snapshot.temporary })
    if (input.budget.toolsRemaining === 0) this.tools = []
    const compiled = assets.composeTask(structuredClone(persona), this.snapshot)
    const event = steering ? assets.compile('taskSteering', { steer_json: structuredClone(steering) }) : null
    if (steering && (steering.taskId !== input.taskId || steering.newGoalVersion !== input.goalVersion)) throw new Error('TASK_CONTEXT_STALE')
    this.systemText = event ? `${compiled.text}\n\n${event.text}` : compiled.text
    this.diagnostic = Object.freeze({ assetReleaseId: compiled.releaseId,
      promptHash: createHash('sha256').update(this.systemText).digest('hex'),
      promptIds: Object.freeze([...compiled.promptIds, ...(event?.promptIds ?? [])]), toolAliases: Object.freeze(this.tools.map(tool => tool.function.name)),
      taskId: input.taskId, runId: input.runId, goalVersion: input.goalVersion })
    this.assertCurrent()
    Object.freeze(this)
  }
  assertCurrent(): void {
    const current = this.current()
    const snapshot = this.snapshot
    if (current.status !== 'running') throw new Error('TASK_NOT_RUNNING')
    if (current.taskId !== snapshot.taskId || current.runId !== snapshot.runId ||
      current.goalVersion !== snapshot.goalVersion || current.contextVersion !== snapshot.contextVersion ||
      current.deletionEpoch !== snapshot.deletionEpoch || current.temporary !== snapshot.temporary) {
      throw new Error('TASK_CONTEXT_STALE')
    }
    if (current.activeMsRemaining < 1) throw new Error('TASK_BUDGET_EXHAUSTED')
    if (this.tools.some(tool => !current.authorizedAliases.includes(tool.function.name))) throw new Error('TASK_AUTHORIZATION_REVOKED')
  }
  finalize(messages: ChatMessage[]): { messages: ChatMessage[]; tools: R1ModelTool[] } {
    this.assertCurrent()
    if (!Array.isArray(messages) || messages.length > 50) throw new Error('MODEL_MESSAGES_INVALID')
    const conversation: ChatMessage[] = []
    for (const message of messages) {
      if (message.role === 'system') continue
      if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' ||
        [...message.content].length > 8000) throw new Error('MODEL_MESSAGES_INVALID')
      conversation.push({ role: message.role, content: message.content })
    }
    return { messages: [{ role: 'system', content: this.systemText }, ...conversation], tools: structuredClone(this.tools) }
  }
  validateToolCall(alias: string, input: unknown): void {
    this.assertCurrent()
    if (!this.tools.some(tool => tool.function.name === alias)) throw new Error('MODEL_TOOL_NOT_EXPOSED')
    this.assets.validateToolInput(alias, input)
  }
  validateHistoricalToolCall(alias: string, input: unknown): void {
    this.assertCurrent()
    if (!this.authorizedAliases.includes(alias) || !this.current().authorizedAliases.includes(alias) ||
      !this.assets.toolDefinition(alias).contexts.includes('task')) throw new Error('MODEL_TOOL_NOT_EXPOSED')
    this.assets.validateToolInput(alias, input)
  }
}
