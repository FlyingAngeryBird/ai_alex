import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { R1TaskRequestBoundary, type R1TaskInput, type R1TaskAuthority } from '../electron/main/r1/taskBoundary'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { createArkResponsesProvider } from '../electron/main/providers/arkResponsesProvider'
const assets = loadR1PromptAssets(resolve('r1-assets'))
const persona = { assistantName: 'Seamo AI', userAddress: '', style: '简洁', voiceId: '', version: 1 }
function fixture(patch: Partial<R1TaskInput> = {}) {
  const input: R1TaskInput = { taskId: 'task', runId: 'run', goalVersion: 1, contextVersion: 1,
    deletionEpoch: 0, status: 'running', goal: '依据明确委托处理便签', constraints: [], sourceRefs: [],
    currentTime: '2026-10-13T15:00:00.000Z', timezone: 'Asia/Shanghai', temporary: false,
    budget: { decisionsRemaining: 4, toolsRemaining: 6, activeMsRemaining: 30000, searchQueriesRemaining: 2, pagesRemaining: 3 },
    validReceiptActionIds: [], observations: [], loadedSkillIds: [], ...patch }
  const authorizedAliases = ['read_file', 'write_todos', 'notes_create', 'start_task', 'memory_recall']
  const current: R1TaskAuthority = { ...input, authorizedAliases, activeMsRemaining: 30000 }
  const boundary = new R1TaskRequestBoundary(assets, persona, input, authorizedAliases, () => current)
  return { boundary, input, current }
}
describe('registered M02 task request boundary', () => {
  it('sends PR01/PR02/PR04 and frozen TaskInput, discarding SDK system and recursive task tools', async () => {
    const { boundary, input } = fixture()
    input.goal = 'later mutation'
    expect(boundary.diagnostic.promptIds).toEqual(['PR01', 'PR02', 'PR04'])
    expect(boundary.systemText).not.toContain('later mutation')
    expect(boundary.diagnostic.promptHash).toBe(createHash('sha256').update(boundary.systemText).digest('hex'))
    expect(boundary.diagnostic.toolAliases).toEqual(['memory_recall', 'read_file', 'write_todos'])
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({
      id: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] }] })))
    await createArkResponsesProvider({ env: { VOLCENGINE_ARK_API_KEY: 'test-key', VOLCENGINE_ARK_MODEL: 'test-model' }, fetch: fetcher })
      .request({ boundary, messages: [{ role: 'system', content: 'uncontrolled SDK prompt' },
        { role: 'user', content: '整理便签' }] })
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string)
    expect(body.instructions).toBe(boundary.systemText)
    expect(body.instructions).not.toContain('uncontrolled SDK prompt')
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'seamo_task_draft_v2', strict: true,
      schema: { title: 'TaskDraft', additionalProperties: false } })
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(['memory_recall', 'read_file', 'write_todos'])
  })
  it('exposes domain writes only after skill load and with authorization; temporary excludes memory', () => {
    expect(fixture({ loadedSkillIds: ['SK03'] }).boundary.diagnostic.toolAliases).toContain('notes_create')
    expect(fixture({ loadedSkillIds: ['SK05'], temporary: true }).boundary.diagnostic.toolAliases).not.toContain('memory_recall')
    expect(() => fixture().boundary.validateToolCall('notes_create', {})).toThrow('MODEL_TOOL_NOT_EXPOSED')
    const zero = fixture()
    const empty = fixture({ budget: { ...zero.input.budget, toolsRemaining: 0 } })
    expect(empty.boundary.diagnostic.toolAliases).toEqual([])
  })
  it('blocks stale goals, run/context/deletion changes, pause and revoked grants before network or tool execution', () => {
    for (const field of ['goalVersion', 'contextVersion', 'deletionEpoch'] as const) {
      const { boundary, current } = fixture()
      current[field]++
      expect(() => boundary.finalize([])).toThrow('TASK_CONTEXT_STALE')
    }
    const paused = fixture(); paused.current.status = 'paused'
    expect(() => paused.boundary.finalize([])).toThrow('TASK_NOT_RUNNING')
    const revoked = fixture(); revoked.current.authorizedAliases = []
    expect(() => revoked.boundary.validateToolCall('read_file', {})).toThrow('TASK_AUTHORIZATION_REVOKED')
    const expired = fixture(); expired.current.activeMsRemaining = 0
    expect(() => expired.boundary.finalize([])).toThrow('TASK_BUDGET_EXHAUSTED')
  })
  it('validates TaskInput schema and never starts a cancelled or exhausted task', () => {
    expect(() => fixture({ goalVersion: 0 })).toThrow('PROMPT_ASSET_VARIABLE_INVALID:task-input')
    expect(() => fixture({ status: 'cancelled' })).toThrow('TASK_NOT_RUNNING')
    const base = fixture()
    expect(() => fixture({ budget: { ...base.input.budget, decisionsRemaining: 0 } })).toThrow('TASK_BUDGET_EXHAUSTED')
  })
  it('rejects late plain text after a new goal even if no function call was returned', async () => {
    const { boundary, current } = fixture()
    const fetcher = vi.fn(async () => {
      current.goalVersion++
      return new Response(JSON.stringify({ id: 'late', status: 'completed', output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old goal answer' }] }
      ] }))
    })
    await expect(createArkResponsesProvider({ env: { VOLCENGINE_ARK_API_KEY: 'key', VOLCENGINE_ARK_MODEL: 'model' }, fetch: fetcher })
      .request({ boundary, messages: [{ role: 'user', content: '整理便签' }] })).rejects.toThrow('TASK_CONTEXT_STALE')
  })
  it('preserves a valid 8000-codepoint artifact plus JSON metadata for Supervisor validation', async () => {
    const { boundary } = fixture()
    const draft = { status: 'completed', goalVersion: 1, replyBrief: '草稿已生成', sourceRefs: [],
      receiptActionIds: [], artifacts: [{ kind: 'text', title: '工作稿', content: '海'.repeat(8000),
        baseArtifactId: null, baseArtifactVersion: null, sourceRefs: [] }], candidates: [], unresolved: [] }
    assets.validateStructured('task-draft', draft)
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'draft', status: 'completed', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(draft) }] }
    ] })))
    const response = await createArkResponsesProvider({ env: { VOLCENGINE_ARK_API_KEY: 'key', VOLCENGINE_ARK_MODEL: 'model' }, fetch: fetcher })
      .request({ boundary, messages: [{ role: 'user', content: '生成工作稿' }] })
    expect(JSON.parse(response.text)).toEqual(draft)
    expect(() => assets.validateStructured('task-draft', { ...draft, artifacts: [{ ...draft.artifacts[0], content: '海'.repeat(8001) }] }))
      .toThrow('PROMPT_ASSET_VARIABLE_INVALID:task-draft')
  })
  it('keeps paired past tool results when no budget remains for new tool calls', async () => {
    const base = fixture()
    const { boundary } = fixture({ budget: { ...base.input.budget, toolsRemaining: 0 } })
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'final', status: 'completed', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{}' }] }
    ] })))
    const result = await createArkResponsesProvider({ env: { VOLCENGINE_ARK_API_KEY: 'key', VOLCENGINE_ARK_MODEL: 'model' }, fetch: fetcher })
      .request({ boundary, messages: [{ role: 'user', content: '整理讨论稿' }], rounds: [{ output: [
        { type: 'function_call', call_id: 'past', name: 'read_file', arguments: '{"file_path":"/skills/work-discussion/SKILL.md"}' }
      ], results: [{ callId: 'past', output: { status: 'succeeded' } }] }] })
    expect(result.text).toBe('{}')
    expect(() => boundary.validateToolCall('read_file', { file_path: '/skills/work-discussion/SKILL.md' })).toThrow('MODEL_TOOL_NOT_EXPOSED')
  })
})
