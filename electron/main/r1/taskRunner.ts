import type { createArkResponsesProvider, ArkResponseRound } from '../providers/arkResponsesProvider.js'
import type { R1Persona } from './persona.js'
import type { R1PromptAssets } from './promptAssets.js'
import type { R1TaskSupervisor, TaskLease } from './taskSupervisor.js'
import type { R1TaskToolExecutor } from './taskToolExecutor.js'
import type { R1Artifacts } from './artifacts.js'
import { R1TaskRequestBoundary } from './taskBoundary.js'
import { R1TaskRepairBoundary } from './taskRepairBoundary.js'

const stableCode = (error: unknown): string => error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message)
  ? error.message : 'TASK_EXECUTION_FAILED'
const canRepair = (error: unknown): boolean => error instanceof SyntaxError || error instanceof Error &&
  (error.message === 'PROMPT_ASSET_VARIABLE_INVALID:task-draft' || error.message === 'ARTIFACT_OUTSIDE_TARGET_CHANGED' || /^(TASK_RESULT_|TASK_COMPLETION_)/.test(error.message))

/** Serial background execution; only Supervisor acceptance/explicit resume can enqueue work. */
export class R1TaskRunner {
  private closed = false
  private active: Promise<void> | null = null
  private unsubscribe: (() => void) | null = null
  constructor(private readonly tasks: R1TaskSupervisor, private readonly assets: R1PromptAssets,
    private readonly executor: R1TaskToolExecutor, private readonly artifacts: R1Artifacts,
    private readonly provider: ReturnType<typeof createArkResponsesProvider>, private readonly persona: () => R1Persona,
    private readonly options: { onDiagnostic?: (event: { taskId: string; runId: string;
      kind: 'structured_rejected' | 'repair_rejected'; code: string }) => void } = {}) {}
  private diagnostic(lease: TaskLease, kind: 'structured_rejected' | 'repair_rejected', error: unknown): void {
    const code = error instanceof SyntaxError ? 'TASK_DRAFT_JSON_INVALID' : error instanceof Error &&
      error.message === 'PROMPT_ASSET_VARIABLE_INVALID:task-draft' ? 'TASK_DRAFT_SCHEMA_INVALID' : stableCode(error)
    try { this.options.onDiagnostic?.({ taskId: lease.taskId, runId: lease.runId, kind, code }) } catch { /* diagnostic only */ }
  }
  private async requestWithinBudget(input: Parameters<ReturnType<typeof createArkResponsesProvider>['request']>[0], remainingMs: number) {
    const deadline = AbortSignal.timeout(Math.max(1, Math.floor(remainingMs)))
    try { return await this.provider.request({ ...input, signal: input.signal ? AbortSignal.any([input.signal, deadline]) : deadline }) }
    catch (error) {
      if (deadline.aborted && !input.signal?.aborted) throw new Error('TASK_BUDGET_EXHAUSTED')
      throw error
    }
  }
  start(): void {
    if (this.unsubscribe || this.closed) return
    this.unsubscribe = this.tasks.onChanged(event => {
      if (['accepted', 'updated', 'completed', 'paused', 'cancelled'].includes(event.reason)) this.schedule()
    })
    this.schedule()
  }
  private schedule(): void {
    if (this.closed || this.active) return
    // Accepted is returned synchronously before any model request starts.
    this.active = Promise.resolve().then(() => this.drain()).finally(() => {
      this.active = null
      if (!this.closed && this.tasks.hasRunnable()) this.schedule()
    })
  }
  async idle(): Promise<void> { while (this.active) await this.active }
  private async drain(): Promise<void> {
    while (!this.closed) {
      const next = this.tasks.claimNext()
      if (!next) return
      try { await this.run(next.lease, next.signal) }
      catch (error) {
        // Cancellation/supersession may already have changed or removed the record.
        try { this.tasks.settlePause(next.lease); this.tasks.stopRun(next.lease, stableCode(error)) } catch { /* gone or closed */ }
      }
    }
  }
  private async run(lease: TaskLease, signal: AbortSignal): Promise<void> {
    this.tasks.verifyRecovery(lease)
    const rounds: ArkResponseRound[] = []
    const source = this.tasks.originalSource(lease)
    const messages = [{ role: 'user' as const, content: source.body }]
    let repaired = false
    while (!this.closed) {
      const input = this.tasks.beginDecision(lease)
      const aliases = this.tasks.authorizedAliases(lease).filter(alias => this.executor.implementedAliases.includes(alias))
      const boundary = new R1TaskRequestBoundary(this.assets, this.persona(), input, aliases,
        () => this.tasks.authority(lease.taskId), this.tasks.steeringEvent(lease))
      const response = await this.requestWithinBudget({ boundary, messages, rounds, signal, maxOutputTokens: 8192 }, input.budget.activeMsRemaining)
      this.tasks.assertLease(lease)
      if (response.calls.length) {
        // Validate against the original round's Skill exposure before executing any same-batch call.
        for (const call of response.calls) boundary.validateToolCall(call.name, JSON.parse(call.arguments))
        const results = []
        for (const call of response.calls) results.push({ callId: call.call_id,
          output: await this.executor.executeAsync(lease, call.name, JSON.parse(call.arguments), call.call_id, signal) })
        rounds.push({ output: response.output, results })
        continue
      }
      try {
        this.tasks.publish(lease, JSON.parse(response.text), this.artifacts)
        return
      } catch (error) {
        this.diagnostic(lease, 'structured_rejected', error)
        if (!canRepair(error)) throw error
        if (repaired || [...response.text].length > 20000) throw new Error('STRUCTURED_OUTPUT_INVALID')
        this.tasks.assertLease(lease)
        repaired = true
        const repairInput = this.tasks.beginDecision(lease)
        const proofs = repairInput.validReceiptActionIds.map(actionId => {
          const receipt = this.tasks.readReceipt(lease, actionId)
          return { actionId: receipt.actionId, tool: receipt.tool, status: receipt.status,
            entityId: receipt.entityId, entityVersion: receipt.entityVersion,
            ...(receipt.status === 'succeeded' && receipt.tool === 'web.search' ? {
              webEvidence: { query: receipt.data.query, queriedAt: receipt.data.queriedAt,
                sources: receipt.data.sources, candidates: receipt.data.candidates } } :
              receipt.status === 'succeeded' && receipt.tool === 'web.readPage' ? {
                webEvidence: { source: receipt.data.source } } : {}) }
        })
        const repair = new R1TaskRepairBoundary(this.assets, response.text,
          [error instanceof SyntaxError ? 'TASK_DRAFT_JSON_INVALID' : error instanceof Error ? error.message : 'TASK_DRAFT_INVALID'],
          repairInput, () => this.tasks.assertLease(lease), proofs, aliases.filter(alias => ['web_search', 'web_read_page'].includes(alias)))
        const repairedResponse = await this.requestWithinBudget({ boundary: repair,
          messages: [{ role: 'user', content: JSON.stringify({ schemaId: 'task-draft', taskId: lease.taskId, goalVersion: lease.goalVersion }) }], signal, maxOutputTokens: 8192 }, repairInput.budget.activeMsRemaining)
        if (repairedResponse.calls.length) throw new Error('STRUCTURED_OUTPUT_INVALID')
        try { this.tasks.publish(lease, JSON.parse(repairedResponse.text), this.artifacts) }
        catch (error) { this.diagnostic(lease, 'repair_rejected', error); throw new Error('STRUCTURED_OUTPUT_INVALID') }
        return
      }
    }
  }
  async close(): Promise<void> {
    this.closed = true; this.unsubscribe?.(); this.unsubscribe = null
    // Supervisor shuts down/aborts before the owner closes the database.
    await this.idle()
  }
}
