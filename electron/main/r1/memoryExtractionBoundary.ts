import type { ChatMessage } from '../providers/llmProvider.js'
import type { R1PromptAssets, R1ModelTool } from './promptAssets.js'

/** Registered PR01/PR05 only, with no business/host tools or extra system instructions. */
export class R1MemoryExtractionBoundary {
  readonly systemText: string
  readonly outputFormat: { name: string; schema: Record<string, unknown> }
  private readonly sourceText: string
  constructor(assets: R1PromptAssets, input: Record<string, unknown>,
    private readonly checkCurrent: () => void) {
    this.systemText = assets.compile('memoryExtraction', { memory_input_json: input }).text
    this.outputFormat = { name: 'memory_candidates', schema: assets.structuredSchema('memory-candidates') }
    this.sourceText = JSON.stringify(input.sourceMessages)
  }
  finalize(_messages: ChatMessage[]): { messages: ChatMessage[]; tools: R1ModelTool[] } {
    this.assertCurrent()
    return { messages: [{ role: 'system', content: this.systemText }, { role: 'user', content: this.sourceText }], tools: [] }
  }
  assertCurrent(): void { this.checkCurrent() }
  validateToolCall(): never { throw new Error('MEMORY_EXTRACTION_TOOLS_FORBIDDEN') }
}
