import { R1FocusTools, focusToolAliases, type FocusToolServices } from './focusTools.js'
import { R1ReminderTools, reminderToolAliases } from './reminderTools.js'
import { createPageReader } from '../providers/pageReader.js'
import { createBraveSearchProvider, SearchProviderError } from '../providers/braveSearchProvider.js'
import { randomUUID } from 'node:crypto'
import type { R1PromptAssets } from './promptAssets.js'
import type { R1TaskSupervisor, TaskLease, TaskToolReceipt } from './taskSupervisor.js'
import type { R1Items } from './items.js'
import { musicAliases, type R1Music } from './music.js'
import { R1MusicTools } from './musicTools.js'
type PlanInput = Parameters<R1TaskSupervisor['updatePlan']>[1]

/** Registered synchronous local tools; no host filesystem, shell or model-controlled authorization. */
export class R1TaskToolExecutor {
  private readonly focusTools = new Map<string, R1FocusTools>()
  private readonly reminders = new Map<string, R1ReminderTools>()
  private readonly musicTools = new Map<string, R1MusicTools>()
  readonly implementedAliases: readonly string[]
  constructor(private readonly tasks: R1TaskSupervisor, private readonly assets: R1PromptAssets,
    private readonly items?: R1Items, private readonly search?: ReturnType<typeof createBraveSearchProvider>, private readonly pages?: ReturnType<typeof createPageReader>, private readonly services?: FocusToolServices,
    private readonly music?: R1Music) {
    this.implementedAliases = Object.freeze(['read_file', 'write_todos', ...(items ? ['notes_create', ...reminderToolAliases] : []), ...(search ? ['web_search'] : []), ...(pages ? ['web_read_page'] : []), ...(services ? focusToolAliases : []), ...(music ? musicAliases : [])])
  }
  private musicSession(lease: TaskLease): R1MusicTools {
    let tools = this.musicTools.get(lease.runId)
    if (!tools) {
      this.musicTools.clear(); const source = this.tasks.originalSource(lease)
      const tasks = this.tasks
      tools = new R1MusicTools(this.music!, { temporary: source.temporary,
        get persistenceConfirmed() { tasks.assertPersistenceAllowed(lease); return true },
        sourceRef: source.messageId, assertCurrent: () => this.tasks.assertLease(lease) })
      this.musicTools.set(lease.runId, tools)
    }
    return tools
  }
  private reminderTools(lease: TaskLease): R1ReminderTools {
    let tools = this.reminders.get(lease.runId)
    if (!tools) {
      this.reminders.clear()
      const source = this.tasks.originalSource(lease)
      tools = new R1ReminderTools(this.items!, { source, assertCurrent: () => this.tasks.assertLease(lease),
        requirePersistence: () => this.tasks.assertPersistenceAllowed(lease), checkSources: refs => this.tasks.assertToolSources(lease, refs) })
      this.reminders.set(lease.runId, tools)
    }
    return tools
  }
  async executeAsync(lease: TaskLease, alias: string, input: unknown, callId?: string, signal?: AbortSignal): Promise<TaskToolReceipt> {
    if ((musicAliases as readonly string[]).includes(alias)) {
      if (!this.music) throw new Error('TASK_TOOL_IMPLEMENTATION_UNAVAILABLE')
      if (['music_get_state', 'music_queue', 'music_favorite', 'music_feedback'].includes(alias)) return this.execute(lease, alias, input, callId)
      return this.music.trackExecution(this.tasks.executeMusicTool(lease, alias, input, () => this.musicSession(lease).execute(alias, input as Record<string, unknown>), callId))
    }
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
    const receipt = this.tasks.executeLocalTool(lease, alias, input, actionId => {
      if ((musicAliases as readonly string[]).includes(alias)) {
        if (alias !== 'music_get_state') this.tasks.assertPersistenceAllowed(lease)
        return { data: this.musicSession(lease).local(alias, input as Record<string, unknown>) }
      }
      if ((focusToolAliases as readonly string[]).includes(alias)) {
        let focus = this.focusTools.get(lease.runId)
        if (!focus) {
          this.focusTools.clear()
          const source = this.tasks.originalSource(lease)
          focus = new R1FocusTools({ ...this.services!, currentTrackKey: () => source.selectedTrackKey ?? null }, source, () => this.tasks.assertLease(lease))
          this.focusTools.set(lease.runId, focus)
        }
        if (alias !== 'focus_get_state') this.tasks.assertPersistenceAllowed(lease)
        return focus.execute(alias, input as Record<string, unknown>, actionId)
      }
      if ((reminderToolAliases as readonly string[]).includes(alias)) return this.reminderTools(lease).execute(alias, input as Record<string, unknown>, actionId)
      let data: Record<string, unknown>
      if (alias === 'read_file') {
        const args = input as { file_path: string; offset?: number; limit?: number }
        if (args.file_path === `/task/${lease.taskId}/source-turn.json`) {
          const source = this.tasks.originalSource(lease)
          const lines = JSON.stringify(source, null, 2).split('\n')
          const offset = args.offset ?? 0; const limit = args.limit ?? 2000
          data = { path: args.file_path, content: lines.slice(offset, offset + limit).join('\n'),
            offset, hasMore: offset + limit < lines.length, assetReleaseId: this.assets.releaseId }
        } else if (args.file_path === `/task/${lease.taskId}/current-artifact.json`) {
          const lines = JSON.stringify(this.tasks.artifactInput(lease), null, 2).split('\n')
          const offset = args.offset ?? 0; const limit = args.limit ?? 2000
          data = { path: args.file_path, content: lines.slice(offset, offset + limit).join('\n'), offset,
            hasMore: offset + limit < lines.length, assetReleaseId: this.assets.releaseId }
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
    if (this.items) this.reminderTools(lease).observe(receipt)
    if (this.music && alias === 'read_file' && receipt.status === 'succeeded') {
      try {
        const replay = JSON.parse(String(receipt.data.content)) as { tool?: string; status?: string; data?: Record<string, unknown> }
        if (replay.tool?.startsWith('music.') && replay.status === 'succeeded' && replay.data) this.musicSession(lease).observe(replay.data)
      } catch { /* Non-receipt material cannot grant a music identity. */ }
    }
    return receipt
  }
}
