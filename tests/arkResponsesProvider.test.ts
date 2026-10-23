import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createArkResponsesProvider, type ArkFunctionCall } from '../electron/main/providers/arkResponsesProvider'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { R1ModelRequestBoundary } from '../electron/main/r1/modelBoundary'
import { modelContext } from './helpers/r1ModelFixtures'
const persona = { assistantName: 'Seamo AI', userAddress: '', style: '简洁', voiceId: '', version: 1 }
const env = { VOLCENGINE_ARK_API_KEY: 'test-key', VOLCENGINE_ARK_MODEL: 'test-model' }
const call: ArkFunctionCall = { type: 'function_call', call_id: 'native-call-id', id: 'item-id',
  name: 'memory_recall', arguments: '{"query":"偏好"}', status: 'completed' }
function boundary() { return new R1ModelRequestBoundary(loadR1PromptAssets(resolve('r1-assets')), persona, modelContext(), ['memory_recall']) }
const response = (output: unknown[], status = 'completed') => new Response(JSON.stringify({ id: 'response-id', status, output }))
const messages = [{ role: 'user' as const, content: '协议测试' }]

describe('Ark Responses native tool protocol', () => {
  it('sends store=false with registered instructions and flat function definitions', async () => {
    const fetcher = vi.fn(async () => response([call]))
    const adapter = createArkResponsesProvider({ env, fetch: fetcher })
    const result = await adapter.request({ boundary: boundary(), messages: [{ role: 'system', content: 'unregistered' },
      { role: 'user', content: '我的偏好是什么' }] })
    expect(result.calls).toEqual([call])
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/responses')
    expect(body).toMatchObject({ store: false, stream: false, input: [{ type: 'message', role: 'user', content: '我的偏好是什么' }] })
    expect(body.instructions).not.toContain('unregistered')
    expect(body.tools[0]).toMatchObject({ type: 'function', name: 'memory_recall', parameters: { type: 'object' } })
    expect(body).not.toHaveProperty('previous_response_id')
    expect(body).not.toHaveProperty('thinking')
  })
  it('disables thinking only for an explicitly configured presentation provider', async () => {
    const fetcher = vi.fn(async () => response([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '结果已就绪。' }] }]))
    await createArkResponsesProvider({ env, fetch: fetcher, thinking: 'disabled' }).request({ boundary: boundary(), messages })
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).thinking).toEqual({ type: 'disabled' })
  })
  it('returns results with the original call_id and preserves reasoning/message items locally', async () => {
    const fetcher = vi.fn(async () => response([{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: '暂时没有匹配的记录。' }] }]))
    await createArkResponsesProvider({ env, fetch: fetcher }).request({ boundary: boundary(),
      messages: [{ role: 'user', content: '回忆偏好' }], rounds: [{ output: [{ type: 'reasoning', id: 'reasoning', summary: [] }, call],
        results: [{ callId: call.call_id, output: { matchStatus: 'no_match', memories: [] } }] }] })
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string).input).toContainEqual({ type: 'function_call_output', call_id: call.call_id,
      output: '{"matchStatus":"no_match","memories":[]}' })
    expect(JSON.parse(init.body as string).input).toContainEqual(call)
  })
  it('rejects orphan/missing results before a network request', async () => {
    const fetcher = vi.fn()
    const adapter = createArkResponsesProvider({ env, fetch: fetcher })
    await expect(adapter.request({ boundary: boundary(), messages: [], rounds: [{ output: [call], results: [] }] }))
      .rejects.toMatchObject({ code: 'ARK_TOOL_PAIRING_INVALID' })
    await expect(adapter.request({ boundary: boundary(), messages: [], rounds: [{ output: [call],
      results: [{ callId: 'different-call', output: {} }] }] })).rejects.toMatchObject({ code: 'ARK_TOOL_PAIRING_INVALID' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it.each([
    [{ ...call, name: 'execute' }, 'ARK_TOOL_SCOPE_OR_SCHEMA_INVALID'],
    [{ ...call, arguments: '{"query":"x","extra":true}' }, 'ARK_TOOL_SCOPE_OR_SCHEMA_INVALID'],
    [{ ...call, arguments: '{bad' }, 'ARK_TOOL_ARGUMENTS_INVALID'],
    [{ type: 'web_search_call' }, 'ARK_UNAUTHORIZED_OUTPUT_TYPE']
  ])('rejects unexposed or invalid protocol output %#', async (item, code) => {
    const adapter = createArkResponsesProvider({ env, fetch: async () => response([item]) })
    await expect(adapter.request({ boundary: boundary(), messages })).rejects.toMatchObject({ code })
  })
  it('does not publish an incomplete or cancelled response', async () => {
    const adapter = createArkResponsesProvider({ env, fetch: async () => response([call], 'incomplete') })
    await expect(adapter.request({ boundary: boundary(), messages })).rejects.toMatchObject({ code: 'ARK_RESPONSE_NOT_COMPLETED' })
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.request({ boundary: boundary(), messages, signal: controller.signal })).rejects.toMatchObject({ code: 'ARK_REQUEST_CANCELLED' })
  })
  it('requires real input after dropping all SDK system messages', async () => {
    const fetcher = vi.fn()
    await expect(createArkResponsesProvider({ env, fetch: fetcher }).request({ boundary: boundary(),
      messages: [{ role: 'system', content: 'SDK system only' }] })).rejects.toMatchObject({ code: 'ARK_INPUT_REQUIRED' })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('keeps a longer configured background deadline cancellable and rejects late responses', async () => {
    const controller = new AbortController()
    const adapter = createArkResponsesProvider({ env, timeoutMs: 60_000, fetch: async (_url, init) => {
      expect(init?.signal?.aborted).toBe(false)
      controller.abort()
      expect(init?.signal?.aborted).toBe(true)
      return response([call])
    } })
    await expect(adapter.request({ boundary: boundary(), messages, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'ARK_REQUEST_CANCELLED' })
  })
  it.each([['max_output_tokens', 'ARK_OUTPUT_BUDGET_EXHAUSTED'], ['length', 'ARK_OUTPUT_BUDGET_EXHAUSTED'], ['content_filter', 'ARK_RESPONSE_FILTERED'], ['private detail', 'ARK_RESPONSE_NOT_COMPLETED']])('labels incomplete reason %s without publishing partial calls', async (reason, code) => {
    const adapter = createArkResponsesProvider({ env, fetch: async () => new Response(JSON.stringify({
      id: 'partial', status: 'incomplete', output: [call], incomplete_details: { reason }
    })) })
    await expect(adapter.request({ boundary: boundary(), messages })).rejects.toMatchObject({ code })
  })
})
