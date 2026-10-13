import type { ChatMessage } from '../providers/llmProvider.js'
import type { ArkModelBoundary } from '../providers/arkResponsesProvider.js'
import type { R1PromptAssets } from './promptAssets.js'
import type { R1TaskInput } from './taskBoundary.js'
import type { TaskToolReceipt } from './taskSupervisor.js'

/** PR10 is an independently compiled, tool-free request; it cannot execute repaired actions. */
export class R1TaskRepairBoundary implements ArkModelBoundary {
  readonly systemText: string
  readonly diagnostic: { assetReleaseId: string; promptHash: string; promptIds: string[] }
  constructor(private readonly assets: R1PromptAssets, invalidOutput: string, errors: string[],
    snapshot: R1TaskInput, private readonly check: () => void,
    receiptProofs: Array<Pick<TaskToolReceipt, 'actionId' | 'tool' | 'status' | 'entityId' | 'entityVersion'>> = []) {
    const compiled = assets.compile('repair', { repair_json: { schemaId: 'task-draft',
      targetSchema: assets.structuredSchema('task-draft'), invalidOutput,
      validationErrors: errors.slice(0, 50), validReferenceIds: [...new Set([...snapshot.sourceRefs,
        ...snapshot.validReceiptActionIds, ...snapshot.observations.map(value => value.refId)])].slice(0, 50),
      sourceSnapshot: { ...structuredClone(snapshot), receiptProofs: structuredClone(receiptProofs),
        artifactBases: snapshot.observations.filter(observation => observation.kind === 'artifact')
          .map(observation => ({ artifactId: observation.refId, version: observation.version })) } } })
    this.systemText = compiled.text
    this.diagnostic = { assetReleaseId: compiled.releaseId, promptHash: compiled.sha256, promptIds: compiled.promptIds }
    this.assertCurrent()
  }
  get outputFormat(): { name: string; schema: Record<string, unknown> } {
    return { name: 'seamo_task_draft_v2', schema: this.assets.structuredSchema('task-draft') }
  }
  assertCurrent(): void { this.check() }
  finalize(messages: ChatMessage[]): ReturnType<ArkModelBoundary['finalize']> {
    this.assertCurrent()
    if (!Array.isArray(messages) || messages.length > 50 || messages.some(message =>
      !['user', 'assistant', 'system'].includes(message.role) || typeof message.content !== 'string' || [...message.content].length > 8000)) {
      throw new Error('MODEL_MESSAGES_INVALID')
    }
    return { messages: [{ role: 'system', content: this.systemText }, ...messages.filter(message => message.role !== 'system')], tools: [] }
  }
  validateToolCall(): never { throw new Error('MODEL_TOOL_NOT_EXPOSED') }
}
