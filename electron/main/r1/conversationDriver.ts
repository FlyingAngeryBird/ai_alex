import type { FocusToolServices } from './focusTools.js'
import { memoryMutationReply } from './memoryTools.js'
import { topicConversationContext } from './topicContext.js'
import { selectedConversationEntity } from './sessionMode.js'
import type { ChatMessage, AssistantOutput } from '../providers/llmProvider.js'
import type { createArkResponsesProvider, ArkResponseRound } from '../providers/arkResponsesProvider.js'
import type { R1PromptAssets } from './promptAssets.js'
import type { R1Persona } from './persona.js'
import type { R1Database } from './database.js'
import type { R1TaskSupervisor } from './taskSupervisor.js'
import { R1ConversationTools, type ConversationToolScope } from './conversationTools.js'
import { R1ModelRequestBoundary } from './modelBoundary.js'
import { R1Artifacts } from './artifacts.js'
import { currentArtifactContext, type ArtifactEditingContext } from './artifactContext.js'

export class R1ConversationDriver {
  constructor(private readonly db: R1Database, private readonly assets: R1PromptAssets,
    private readonly tasks: R1TaskSupervisor, private readonly provider: ReturnType<typeof createArkResponsesProvider>,
    private readonly persona: () => R1Persona, private readonly implementedTaskAliases: readonly string[], private readonly services?: FocusToolServices,
    private readonly artifacts: R1Artifacts = new R1Artifacts(db)) {}
  artifactContext(mode: import('./sessionMode.js').R1SessionMode | undefined) { return currentArtifactContext(mode, this.artifacts) }
  topicContext(mode: import('./sessionMode.js').R1SessionMode | undefined) { return topicConversationContext(this.db, mode) }
  selectedEntity(mode: import('./sessionMode.js').R1SessionMode | undefined) {
    return selectedConversationEntity(mode, this.tasks)
  }
  async reply(input: { scope: ConversationToolScope; messages: ChatMessage[]; context: Record<string, unknown> }): Promise<AssistantOutput> {
    const tools = new R1ConversationTools(this.db, this.assets, this.tasks, { ...input.scope,
      selectedArtifact: input.context.currentArtifact as ArtifactEditingContext | null | undefined }, this.implementedTaskAliases, this.services, this.artifacts)
    const rounds: ArkResponseRound[] = []
    // The conversation only dispatches immediate actions/control; long work has its own frozen Task budget.
    let remainingTools = 6
    for (let decision = 0; decision < 4; decision++) {
      input.scope.assertCurrent()
      const activeTasks = this.tasks.list(input.scope.temporary ? input.scope.source.sessionId : null).slice(-50)
        .map(task => this.tasks.modelView(task.taskId))
        .map(({ taskId, goalVersion, status, goal }) => ({ taskId, goalVersion, status, goal }))
      const context = { ...input.context, activeTasks, loadedSkillIds: [...tools.loadedSkillIds] }
      const boundary = new R1ModelRequestBoundary(this.assets, this.persona(), context,
        tools.aliases, 'textOnly', input.scope.assertCurrent, remainingTools === 0, this.implementedTaskAliases)
      const response = await this.provider.request({ boundary, messages: input.messages, rounds, signal: input.scope.signal })
      input.scope.assertCurrent()
      if (response.calls.length) {
        if (response.calls.length > remainingTools) throw new Error('CONVERSATION_TOOL_BUDGET_EXHAUSTED')
        for (const call of response.calls) boundary.validateToolCall(call.name, JSON.parse(call.arguments))
        const results: ArkResponseRound['results'] = []
        for (const call of response.calls) {
          remainingTools--
          results.push({ callId: call.call_id, output: tools.execute(call.name, JSON.parse(call.arguments), call.call_id) })
          if (tools.memoryConfirmation) return { intent: 'chat', music: null, reply: '这条记忆还没有保存，请在确认框中决定。' }
          if (tools.memoryMutationReceipt) return { intent: 'chat', music: null, reply: memoryMutationReply(tools.memoryMutationReceipt) }
        }
        rounds.push({ output: response.output, results }); continue
      }
      return { intent: 'chat', music: null, reply: response.text }
    }
    throw new Error('CONVERSATION_DECISION_BUDGET_EXHAUSTED')
  }
}
