import { createHash } from 'node:crypto'
import type { ChatMessage } from '../providers/llmProvider.js'
import type { R1Persona } from './persona.js'
import type { R1ModelTool, R1PromptAssets } from './promptAssets.js'
type ToolSchema = { properties?: Record<string, ToolSchema>; items?: ToolSchema; enum?: string[]; maxItems?: number }

export class R1ModelRequestBoundary {
  readonly systemText: string
  readonly diagnostic: Readonly<{ assetReleaseId: string; promptHash: string; toolAliases: readonly string[] }>
  private readonly tools: R1ModelTool[]
  private readonly validateInput: (alias: string, input: unknown) => void
  private readonly checkCurrent: () => void
  private readonly historicalAliases: string[]
  private readonly assetTools: R1PromptAssets

  constructor(assets: R1PromptAssets, persona: R1Persona, context: Record<string, unknown>,
    authorizedAliases: string[] = [], mode: 'textOnly' | 'realtime' = 'textOnly', checkCurrent: () => void = () => undefined,
    toolBudgetEmpty = false, implementedTaskAliases?: readonly string[]) {
    this.checkCurrent = checkCurrent
    this.historicalAliases = [...authorizedAliases]; this.assetTools = assets
    const snapshot = structuredClone(context)
    const loadedSkillIds = snapshot.loadedSkillIds as string[]
    if (!Array.isArray(loadedSkillIds) || !loadedSkillIds.includes('SK01')) {
      throw new Error('MODEL_PRELOADED_SKILL_MISSING')
    }
    this.tools = assets.exposeTools({ channel: 'realtime', loadedSkillIds,
      authorizedAliases, temporary: snapshot.temporary === true })
    if (implementedTaskAliases) {
      if (!implementedTaskAliases.length) this.tools = this.tools.filter(tool => !['start_task', 'steer_task'].includes(tool.function.name))
      for (const tool of this.tools) if (['start_task', 'steer_task'].includes(tool.function.name)) {
        const fields = (tool.function.parameters as ToolSchema).properties!.delegation.properties!
        const available = fields.toolAliases.items!.enum!.filter(alias => implementedTaskAliases.includes(alias))
        if (available.length) fields.toolAliases.items!.enum = available
        else fields.toolAliases.maxItems = 0
        const required = fields.requiredActions.items!.properties!.alias.enum!.filter(alias => implementedTaskAliases.includes(alias))
        if (required.length) fields.requiredActions.items!.properties!.alias.enum = required
        else fields.requiredActions.maxItems = 0
      }
    }
    if (toolBudgetEmpty) this.tools = []
    this.validateInput = (alias, input) => {
      assets.validateToolInput(alias, input)
      if (implementedTaskAliases && ['start_task', 'steer_task'].includes(alias)) {
        const delegation = (input as { delegation?: { toolAliases?: string[]; requiredActions?: Array<{ alias: string }> } }).delegation
        if (delegation) {
          const names = [...(delegation.toolAliases ?? []), ...(delegation.requiredActions ?? []).map(action => action.alias)]
          if (names.some(name => !implementedTaskAliases.includes(name))) throw new Error('MODEL_TOOL_NOT_EXPOSED')
        }
      }
    }
    snapshot.availableToolAliases = this.tools.map(tool => tool.function.name)
    this.systemText = assets.compose(structuredClone(persona), snapshot, mode)
    this.diagnostic = Object.freeze({ assetReleaseId: assets.releaseId,
      promptHash: createHash('sha256').update(this.systemText).digest('hex'),
      toolAliases: Object.freeze([...snapshot.availableToolAliases as string[]]) })
    Object.freeze(this)
  }

  finalize(messages: ChatMessage[]): { messages: ChatMessage[]; tools: R1ModelTool[] } {
    this.assertCurrent()
    if (!Array.isArray(messages) || messages.length > 50) throw new Error('MODEL_MESSAGES_INVALID')
    const conversation: ChatMessage[] = []
    for (const message of messages) {
      // Upstream SDK/system additions cannot become business instructions.
      if (message.role === 'system') continue
      if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' ||
        [...message.content].length > 8000) throw new Error('MODEL_MESSAGES_INVALID')
      conversation.push({ role: message.role, content: message.content })
    }
    return { messages: [{ role: 'system', content: this.systemText }, ...conversation],
      tools: structuredClone(this.tools) }
  }
  validateToolCall(alias: string, input: unknown): void {
    this.assertCurrent()
    if (!this.tools.some(tool => tool.function.name === alias)) throw new Error('MODEL_TOOL_NOT_EXPOSED')
    this.validateInput(alias, input)
  }
  assertCurrent(): void { this.checkCurrent() }
  validateHistoricalToolCall(alias: string, input: unknown): void {
    this.assertCurrent()
    if (!this.historicalAliases.includes(alias) || !this.assetTools.toolDefinition(alias).contexts.includes('realtime')) throw new Error('MODEL_TOOL_NOT_EXPOSED')
    this.validateInput(alias, input)
  }
}
