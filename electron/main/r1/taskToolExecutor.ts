import type { R1PromptAssets } from './promptAssets.js'
import type { R1TaskSupervisor, TaskLease, TaskToolReceipt } from './taskSupervisor.js'
type PlanInput = Parameters<R1TaskSupervisor['updatePlan']>[1]

/** Internal task tools use registered schemas and real local state; no host filesystem or shell. */
export class R1TaskToolExecutor {
  constructor(private readonly tasks: R1TaskSupervisor, private readonly assets: R1PromptAssets) {}
  execute(lease: TaskLease, alias: string, input: unknown): TaskToolReceipt {
    this.tasks.assertLease(lease)
    this.assets.validateToolInput(alias, input)
    if (!['read_file', 'write_todos'].includes(alias)) throw new Error('TASK_TOOL_IMPLEMENTATION_UNAVAILABLE')
    const actionId = this.tasks.consumeTool(lease, alias)
    let data: Record<string, unknown>
    try {
      if (alias === 'read_file') {
        const args = input as { file_path: string; offset?: number; limit?: number }
        if (args.file_path === `/task/${lease.taskId}/source-turn.json`) {
          const source = this.tasks.originalSource(lease)
          const lines = JSON.stringify(source, null, 2).split('\n')
          const offset = args.offset ?? 0; const limit = args.limit ?? 2000
          data = { path: args.file_path, content: lines.slice(offset, offset + limit).join('\n'),
            offset, hasMore: offset + limit < lines.length, assetReleaseId: this.assets.releaseId }
        } else {
          const result = this.assets.readSkillFile(args.file_path, args.offset, args.limit)
          data = result.data
          if (result.loadedSkillId) this.tasks.loadSkill(lease, result.loadedSkillId)
        }
      } else data = this.tasks.updatePlan(lease, (input as { steps: PlanInput }).steps)
      this.tasks.assertLease(lease)
      const result: TaskToolReceipt = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name,
        status: 'succeeded', entityId: null, entityVersion: null, data, errorCode: null, retryable: false, runId: lease.runId }
      this.tasks.recordInternalReceipt(lease, result)
      return result
    } catch (error) {
      this.tasks.assertLease(lease)
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'TASK_TOOL_FAILED'
      const result: TaskToolReceipt = { kind: 'receipt', actionId, tool: this.assets.toolDefinition(alias).name,
        status: 'failed', entityId: null, entityVersion: null, data: {}, errorCode: code, retryable: false, runId: lease.runId }
      this.tasks.recordInternalReceipt(lease, result)
      return result
    }
  }
}
