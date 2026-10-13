import { createHash } from 'node:crypto'
import type { ChatMessage } from '../providers/llmProvider.js'
import type { R1Persona } from './persona.js'
import type { R1ModelTool, R1PromptAssets } from './promptAssets.js'

export class R1ModelRequestBoundary {
  readonly systemText: string
  readonly diagnostic: Readonly<{ assetReleaseId: string; promptHash: string; toolAliases: readonly string[] }>
  private readonly tools: R1ModelTool[]

  constructor(assets: R1PromptAssets, persona: R1Persona, context: Record<string, unknown>,
    authorizedAliases: string[] = []) {
    const snapshot = structuredClone(context)
    const loadedSkillIds = snapshot.loadedSkillIds as string[]
    if (!Array.isArray(loadedSkillIds) || !loadedSkillIds.includes('SK01')) {
      throw new Error('MODEL_PRELOADED_SKILL_MISSING')
    }
    this.tools = assets.exposeTools({ channel: 'realtime', loadedSkillIds,
      authorizedAliases, temporary: snapshot.temporary === true })
    snapshot.availableToolAliases = this.tools.map(tool => tool.function.name)
    this.systemText = assets.compose(structuredClone(persona), snapshot)
    this.diagnostic = Object.freeze({ assetReleaseId: assets.releaseId,
      promptHash: createHash('sha256').update(this.systemText).digest('hex'),
      toolAliases: Object.freeze([...snapshot.availableToolAliases as string[]]) })
    Object.freeze(this)
  }

  finalize(messages: ChatMessage[]): { messages: ChatMessage[]; tools: R1ModelTool[] } {
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
}
