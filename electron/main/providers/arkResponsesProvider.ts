import type { ChatMessage } from './llmProvider.js'
import type { R1ModelTool } from '../r1/promptAssets.js'

export type ArkModelBoundary = {
  readonly systemText: string
  finalize(messages: ChatMessage[]): { messages: ChatMessage[]; tools: R1ModelTool[] }
  validateToolCall(alias: string, input: unknown): void
  assertCurrent?(): void
  readonly outputFormat?: { name: string; schema: Record<string, unknown> }
}

export type ArkFunctionCall = { type: 'function_call'; id?: string; call_id: string;
  name: string; arguments: string; status?: string }
export type ArkOutputItem = ArkFunctionCall | {
  type: 'message'; id?: string; role: 'assistant'; status?: string;
  content: Array<{ type: 'output_text'; text: string; annotations?: unknown[] }>
} | { type: 'reasoning'; id?: string; summary?: unknown[]; encrypted_content?: string | null }
export type ArkToolResult = { callId: string; output: unknown }
export type ArkResponseRound = { output: ArkOutputItem[]; results: ArkToolResult[] }
export type ArkResponse = { id: string; output: ArkOutputItem[]; calls: ArkFunctionCall[];
  text: string; usage: Record<string, unknown> | null }
type Environment = { VOLCENGINE_ARK_API_KEY?: string; VOLCENGINE_ARK_BASE_URL?: string; VOLCENGINE_ARK_MODEL?: string }
type ResponseBody = { id?: unknown; status?: unknown; output?: unknown; usage?: unknown; error?: unknown }
export class ArkResponsesError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ArkResponsesError' }
}
function invalid(code: string): never { throw new ArkResponsesError(code) }

function checkedOutput(value: unknown, boundary: ArkModelBoundary): ArkOutputItem[] {
  if (!Array.isArray(value) || value.length > 100) invalid('ARK_OUTPUT_INVALID')
  if (JSON.stringify(value).length > 1_048_576) invalid('ARK_OUTPUT_TOO_LARGE')
  const output = value as ArkOutputItem[]
  const calls = new Set<string>()
  for (const item of output) {
    if (!item || typeof item !== 'object') invalid('ARK_OUTPUT_INVALID')
    if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || !item.call_id || item.call_id.length > 300 ||
        calls.has(item.call_id) || typeof item.name !== 'string' ||
        typeof item.arguments !== 'string' || item.arguments.length > 80_000 ||
        (item.status !== undefined && item.status !== 'completed')) invalid('ARK_TOOL_CALL_INVALID')
      calls.add(item.call_id)
      let args: unknown
      try { args = JSON.parse(item.arguments) } catch { invalid('ARK_TOOL_ARGUMENTS_INVALID') }
      try { boundary.validateToolCall(item.name, args) } catch { invalid('ARK_TOOL_SCOPE_OR_SCHEMA_INVALID') }
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content) ||
        item.content.some(part => !part || part.type !== 'output_text' || typeof part.text !== 'string')) invalid('ARK_MESSAGE_INVALID')
    } else if (item.type === 'reasoning') {
      if ((item.summary !== undefined && !Array.isArray(item.summary)) ||
        (item.encrypted_content != null && typeof item.encrypted_content !== 'string')) invalid('ARK_REASONING_ITEM_INVALID')
    } else invalid('ARK_UNAUTHORIZED_OUTPUT_TYPE')
  }
  return structuredClone(output)
}

/** Stateless Ark Responses transport; business execution stays with the application ToolExecutor. */
export function createArkResponsesProvider(options: { env?: Environment;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>; timeoutMs?: number } = {}) {
  return {
    async request(input: { boundary: ArkModelBoundary; messages: ChatMessage[];
      rounds?: ArkResponseRound[]; signal?: AbortSignal; maxOutputTokens?: number }): Promise<ArkResponse> {
      const env = options.env ?? process.env
      const key = env.VOLCENGINE_ARK_API_KEY?.trim()
      const model = env.VOLCENGINE_ARK_MODEL?.trim()
      if (!key || !model) invalid('ARK_NOT_CONFIGURED')
      const maxOutputTokens = input.maxOutputTokens ?? 2048
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16000) invalid('ARK_INVALID_OUTPUT_BUDGET')
      const prepared = input.boundary.finalize(input.messages)
      const history: unknown[] = prepared.messages.filter(message => message.role !== 'system')
        .map(message => ({ type: 'message', role: message.role, content: message.content }))
      const allCallIds = new Set<string>()
      const rounds = input.rounds ?? []
      if (rounds.length > 12) invalid('ARK_TOO_MANY_ROUNDS')
      for (const round of rounds) {
        const output = checkedOutput(round.output, input.boundary)
        const calls = output.filter((item): item is ArkFunctionCall => item.type === 'function_call')
        if (!Array.isArray(round.results) || round.results.length !== calls.length ||
          new Set(round.results.map(result => result.callId)).size !== calls.length ||
          round.results.some(result => !calls.some(call => call.call_id === result.callId))) invalid('ARK_TOOL_PAIRING_INVALID')
        for (const call of calls) {
          if (allCallIds.has(call.call_id)) invalid('ARK_DUPLICATE_CALL_ID')
          allCallIds.add(call.call_id)
        }
        history.push(...output)
        for (const result of round.results) {
          const text = JSON.stringify(result.output)
          if (typeof text !== 'string' || text.length > 200_000) invalid('ARK_TOOL_RESULT_INVALID')
          history.push({ type: 'function_call_output', call_id: result.callId, output: text })
        }
      }
      if (!history.length) invalid('ARK_INPUT_REQUIRED')
      const tools = prepared.tools.map(tool => ({ type: 'function', ...tool.function }))
      const outputFormat = input.boundary.outputFormat
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000)
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout
      if (signal.aborted) invalid('ARK_REQUEST_CANCELLED')
      const fetcher = options.fetch ?? globalThis.fetch
      let body: ResponseBody | null = null
      try {
        const response = await fetcher(`${(env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3').trim().replace(/\/$/, '')}/responses`, {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ model, store: false, stream: false, instructions: input.boundary.systemText,
            input: history, tools, max_output_tokens: maxOutputTokens,
            ...(outputFormat ? { text: { format: { type: 'json_schema', name: outputFormat.name,
              schema: outputFormat.schema, strict: true } } } : {}) })
        })
        if (!response.ok) invalid(`ARK_HTTP_${response.status}`)
        body = await response.json() as ResponseBody
      } catch (error) {
        if (input.signal?.aborted) invalid('ARK_REQUEST_CANCELLED')
        if (timeout.aborted) invalid('ARK_REQUEST_TIMEOUT')
        if (error instanceof ArkResponsesError) throw error
        invalid('ARK_PROTOCOL_OR_NETWORK_FAILED')
      }
      if (input.signal?.aborted) invalid('ARK_REQUEST_CANCELLED')
      if (timeout.aborted) invalid('ARK_REQUEST_TIMEOUT')
      input.boundary.assertCurrent?.()
      if (!body || body.error || body.status !== 'completed' || typeof body.id !== 'string' || !body.id) invalid('ARK_RESPONSE_NOT_COMPLETED')
      const output = checkedOutput(body.output, input.boundary)
      const calls = output.filter((item): item is ArkFunctionCall => item.type === 'function_call')
      if (calls.some(call => allCallIds.has(call.call_id))) invalid('ARK_DUPLICATE_CALL_ID')
      const text = output.filter(item => item.type === 'message').flatMap(item => item.content.map(part => part.text)).join('\n')
      // The 8000 limit applies to each product body; structured JSON includes schema metadata.
      if ([...text].length > (outputFormat ? 1_048_576 : 8000)) invalid('ARK_TEXT_TOO_LONG')
      if (!text && !calls.length) invalid('ARK_EMPTY_RESPONSE')
      return { id: body.id, output, calls, text,
        usage: body.usage && typeof body.usage === 'object' ? body.usage as Record<string, unknown> : null }
    }
  }
}
