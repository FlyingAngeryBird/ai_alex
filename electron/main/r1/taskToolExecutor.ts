import { createPageReader } from '../providers/pageReader.js'
import { createBraveSearchProvider, SearchProviderError } from '../providers/braveSearchProvider.js'
import { randomUUID } from 'node:crypto'
import type { R1PromptAssets } from './promptAssets.js'
import type { R1TaskSupervisor, TaskLease, TaskToolReceipt } from './taskSupervisor.js'
import type { R1Items } from './items.js'
type PlanInput = Parameters<R1TaskSupervisor['updatePlan']>[1]

/** Registered synchronous local tools; no host filesystem, shell or model-controlled authorization. */
export class R1TaskToolExecutor {
  readonly implementedAliases: readonly string[]
  constructor(private readonly tasks: R1TaskSupervisor, private readonly assets: R1PromptAssets,
    private readonly items?: R1Items, private readonly search?: ReturnType<typeof createBraveSearchProvider>, private readonly pages?: ReturnType<typeof createPageReader>) {
    this.implementedAliases = Object.freeze(['read_file', 'write_todos', ...(items ? ['notes_create'] : []), ...(search ? ['web_search'] : []), ...(pages ? ['web_read_page'] : [])])
  }
  async executeAsync(lease: TaskLease, alias: string, input: unknown, callId?: string, signal?: AbortSignal): Promise<TaskToolReceipt> {
    if (alias === 'web_read_page') {
      if (!this.pages) throw new Error('TASK_TOOL_IMPLEMENTATION_UNAVAILABLE')
      const args = input as Parameters<NonNullable<typeof this.pages>['read']>[0]
      this.tasks.assertLease(lease); this.assets.validateToolInput(alias, input)
      if (args.sourceRef) this.tasks.assertPageSource(lease, args.sourceRef, args.url)
      return this.tasks.executeReadTool(lease, alias, input, () => this.pages!.read(args, signal), callId)
    }
    if (alias !== 'web_search') return this.execute(lease, alias, input, callId)
    if (!this.search) throw new Error('TASK_TOOL_IMPLEMENTATION_UNAVAILABLE')
    return this.tasks.executeReadTool(lease, alias, input, async () => {
      const args = input as { query: string; dateRange?: string | null; location?: string | null }
      const query = [args.query, args.location, args.dateRange].filter(Boolean).join(' ')
      let result: Awaited<ReturnType<typeof this.search.search>>
      try { result = await this.search!.search(query, signal) }
      catch (error) { throw new Error(error instanceof SearchProviderError ? error.code : 'SEARCH_REMOTE_FAILED') }
      return { resultId: randomUUID(), query: result.query, queriedAt: result.queriedAtUtc,
        sources: result.candidates.map(candidate => ({ sourceRef: `source:${candidate.candidateId}`, url: candidate.url,
          title: candidate.title, publishedAt: candidate.pageDate, accessedAt: candidate.queriedAtUtc,
          readStatus: 'not_read', snippet: candidate.snippet })),
        candidates: result.candidates.map(candidate => ({ candidateId: candidate.candidateId,
          label: [...candidate.title].slice(0, 200).join(''), sourceRefs: [`source:${candidate.candidateId}`],
          fields: [{ key: 'search_summary', value: candidate.snippet, verification: 'unconfirmed', sourceRefs: [`source:${candidate.candidateId}`] }] })) }
    }, callId)
  }
  execute(lease: TaskLease, alias: string, input: unknown, callId?: string): TaskToolReceipt {
    this.tasks.assertLease(lease)
    this.assets.validateToolInput(alias, input)
    if (!this.implementedAliases.includes(alias)) throw new Error('TASK_TOOL_IMPLEMENTATION_UNAVAILABLE')
    return this.tasks.executeLocalTool(lease, alias, input, actionId => {
      let data: Record<string, unknown>
      if (alias === 'read_file') {
        const args = input as { file_path: string; offset?: number; limit?: number }
        if (args.file_path === `/task/${lease.taskId}/source-turn.json`) {
          const source = this.tasks.originalSource(lease)
          const lines = JSON.stringify(source, null, 2).split('\n')
          const offset = args.offset ?? 0; const limit = args.limit ?? 2000
          data = { path: args.file_path, content: lines.slice(offset, offset + limit).join('\n'),
            offset, hasMore: offset + limit < lines.length, assetReleaseId: this.assets.releaseId }
        } else if (args.file_path.startsWith(`/task/${lease.taskId}/receipts/`) && args.file_path.endsWith('.json')) {
          const actionId = args.file_path.slice(`/task/${lease.taskId}/receipts/`.length, -'.json'.length)
          const lines = JSON.stringify(this.tasks.readReceipt(lease, actionId), null, 2).split('\n')
          const offset = args.offset ?? 0; const limit = args.limit ?? 2000
          data = { path: args.file_path, content: lines.slice(offset, offset + limit).join('\n'), offset,
            hasMore: offset + limit < lines.length, assetReleaseId: this.assets.releaseId }
        } else {
          const result = this.assets.readSkillFile(args.file_path, args.offset, args.limit)
          data = result.data
          if (result.loadedSkillId) this.tasks.loadSkill(lease, result.loadedSkillId)
        }
      } else if (alias === 'write_todos') data = this.tasks.updatePlan(lease, (input as { steps: PlanInput }).steps)
      else {
        const args = input as { type: 'note' | 'todo'; title: string; content: string; mode: 'original' | 'organized'; sourceRefs: string[] }
        this.tasks.assertPersistenceAllowed(lease); this.tasks.assertToolSources(lease, args.sourceRefs)
        const saved = this.items!.create({ actionId, kind: args.type, title: args.title, body: args.content,
          sourceRefs: args.sourceRefs, preserveBody: args.mode === 'original' })
        return { data: { item: this.items!.toolView(saved.item.itemId) }, entityId: saved.item.itemId, entityVersion: saved.item.version }
      }
      return { data }
    }, callId)
  }
}
