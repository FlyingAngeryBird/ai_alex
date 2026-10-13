import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1PersonaStore } from '../electron/main/r1/persona'
import { R1Items } from '../electron/main/r1/items'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1TaskToolExecutor } from '../electron/main/r1/taskToolExecutor'
import { R1TaskRunner } from '../electron/main/r1/taskRunner'
import { R1Artifacts } from '../electron/main/r1/artifacts'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import type { ArkResponse, createArkResponsesProvider } from '../electron/main/providers/arkResponsesProvider'
type Request = Parameters<ReturnType<typeof createArkResponsesProvider>['request']>[0]
const assets = loadR1PromptAssets(resolve('r1-assets'))
const draft = (version = 1) => ({ status: 'completed', goalVersion: version, replyBrief: '整理完成',
  sourceRefs: [], receiptActionIds: [], artifacts: [{ kind: 'text', title: '工作稿', content: '模型测试稿件',
    baseArtifactId: null, baseArtifactVersion: null, sourceRefs: [] }], candidates: [], unresolved: [] })
const response = (text: string, calls: ArkResponse['calls'] = []): ArkResponse => ({ id: 'response', text, calls,
  output: calls.length ? calls : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: null })
const call = (id: string, name: string, args: unknown) => ({ type: 'function_call' as const, call_id: id, name,
  arguments: JSON.stringify(args) })
function setup(request: (input: Request) => Promise<ArkResponse>, temporary = false, persistenceConfirmed = false,
  requiredActions: Array<{ alias: string; minimumCount: number }> = []) {
  const db = openR1Database(':memory:')
  const conversations = new R1Conversations(db)
  const sessionId = conversations.start(temporary)
  const source = conversations.append({ sessionId, turnId: 'turn', role: 'user', body: '整理并保存三步操作说明', status: 'final' })
  const tasks = new R1TaskSupervisor(db, assets, () => 0, { temporarySource: id => temporary && id === source.messageId
    ? { ...source, timezone: 'Asia/Shanghai', temporary: true } : undefined })
  const runner = new R1TaskRunner(tasks, assets, new R1TaskToolExecutor(tasks, assets, new R1Items(db)),
    new R1Artifacts(db), { request }, () => new R1PersonaStore(db).get())
  const accept = () => tasks.accept({ requestKey: 'request', sourceMessageId: source.messageId, timezone: 'Asia/Shanghai',
    goal: '整理并保存三步操作说明', constraints: [], authorizedAliases: ['read_file', 'write_todos', 'notes_create'],
    complexity: 'light', persistenceConfirmed, requiredActions })
  return { db, tasks, runner, conversations, source, accept, close: async () => { tasks.close(); await runner.close(); db.close() } }
}
describe('bounded R1 background task runner', () => {
  it('returns accepted before network work, pairs original calls and commits a real note once', async () => {
    let index = 0
    const request = vi.fn(async (input: Request) => {
      const prepared = input.boundary.finalize(input.messages)
      if (index++ === 0) {
        expect(prepared.tools.map(tool => tool.function.name)).not.toContain('notes_create')
        return response('', [call('skill-call', 'read_file', { file_path: '/skills/capture-item/SKILL.md' })])
      }
      if (index === 2) {
        expect(input.rounds![0].results[0].callId).toBe('skill-call')
        expect(prepared.tools.map(tool => tool.function.name)).toContain('notes_create')
        return response('', [call('note-call', 'notes_create', { type: 'note', title: '说明', content: '  保留原文格式\n',
          mode: 'original', sourceRefs: [] })])
      }
      const result = input.rounds![1].results[0].output as { actionId: string; status: string; data: { item: { itemId: string } } }
      expect(result.status).toBe('succeeded')
      expect(input.rounds![1].results[0].callId).toBe('note-call')
      return response(JSON.stringify({ ...draft(), artifacts: [], receiptActionIds: input.rounds!.flatMap(round =>
        round.results.map(result => (result.output as { actionId: string }).actionId)) }))
    })
    const s = setup(request)
    try {
      s.runner.start(); const task = s.accept()
      expect(task.status).toBe('accepted'); expect(request).not.toHaveBeenCalled()
      await s.runner.idle()
      expect(s.tasks.get(task.taskId).status).toBe('succeeded')
      expect(new R1Items(s.db).list()).toMatchObject([{ body: '  保留原文格式\n', version: 1 }])
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()).toMatchObject({ n: 2 })
      expect(s.tasks.accept({ requestKey: 'request', sourceMessageId: s.source.messageId, timezone: 'Asia/Shanghai',
        goal: '整理并保存三步操作说明', constraints: [], authorizedAliases: ['read_file', 'write_todos', 'notes_create'], complexity: 'light' }).taskId).toBe(task.taskId)
      await s.runner.idle(); expect(request).toHaveBeenCalledTimes(3)
    } finally { await s.close() }
  })
  it('waits for a pending request to settle before pausing and resumes with a fresh run', async () => {
    let resolveFirst!: (value: ArkResponse) => void
    const pending = new Promise<ArkResponse>(resolve => { resolveFirst = resolve })
    const request = vi.fn<(input: Request) => Promise<ArkResponse>>().mockReturnValueOnce(pending)
      .mockResolvedValue(response(JSON.stringify(draft())))
    const s = setup(request)
    try {
      s.runner.start(); const task = s.accept()
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
      const firstRun = s.tasks.get(task.taskId).runId
      expect(s.tasks.pause(task.taskId, 1).status).toBe('running')
      resolveFirst(response(JSON.stringify(draft())))
      await s.runner.idle()
      expect(s.tasks.get(task.taskId).status).toBe('paused')
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toMatchObject({ n: 0 })
      s.tasks.resume(task.taskId, 1); await s.runner.idle()
      expect(s.tasks.get(task.taskId)).toMatchObject({ status: 'succeeded' })
      expect(s.tasks.get(task.taskId).runId).not.toBe(firstRun)
    } finally { await s.close() }
  })
  it('drops a late old goal and uses registered PR08 before publishing the updated result', async () => {
    let resolveFirst!: (value: ArkResponse) => void
    const request = vi.fn<(input: Request) => Promise<ArkResponse>>().mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
      .mockImplementation(async input => {
        expect(input.boundary.systemText).toContain('经过校验的新目标事件')
        expect(input.boundary.systemText).toContain('改成两步')
        return response(JSON.stringify(draft(2)))
      })
    const s = setup(request)
    try {
      s.runner.start(); const task = s.accept()
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
      const changed = s.conversations.append({ sessionId: s.source.sessionId, turnId: 'next', role: 'user', body: '改成两步', status: 'final' })
      s.tasks.steer({ taskId: task.taskId, expectedGoalVersion: 1, goal: changed.body, constraints: [], sourceMessageId: changed.messageId })
      expect(request).toHaveBeenCalledTimes(1)
      resolveFirst(response(JSON.stringify(draft())))
      await s.runner.idle()
      expect(s.tasks.get(task.taskId)).toMatchObject({ status: 'succeeded', goalVersion: 2 })
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toMatchObject({ n: 1 })
    } finally { await s.close() }
  })
  it('stops at the decision budget and renews only after explicit continue', async () => {
    let index = 0
    const request = vi.fn(async () => response('', [call(`call-${++index}`, 'read_file', { file_path: '/skills/work-discussion/SKILL.md' })]))
    const s = setup(request)
    try {
      s.runner.start(); const task = s.accept(); await s.runner.idle()
      expect(request).toHaveBeenCalledTimes(4)
      expect(s.tasks.get(task.taskId)).toMatchObject({ status: 'partially_succeeded', budget: { decisionsRemaining: 0 },
        result: { completionStatus: 'partial', unresolved: ['TASK_BUDGET_EXHAUSTED'] } })
      request.mockImplementation(async () => response(JSON.stringify({ ...draft(), receiptActionIds:
        (s.tasks.get(task.taskId).result?.entityReceipts ?? []).map(receipt => receipt.actionId) })))
      s.tasks.resume(task.taskId, 1); await s.runner.idle()
      expect(request).toHaveBeenCalledTimes(5)
      expect(s.tasks.get(task.taskId).status).toBe('succeeded')
    } finally { await s.close() }
  })
  it('repairs invalid output exactly once via registered PR10 with no tools or writes', async () => {
    const request = vi.fn<(input: Request) => Promise<ArkResponse>>().mockResolvedValueOnce(response('{bad json'))
      .mockImplementation(async input => {
        expect(input.boundary.finalize(input.messages).tools).toEqual([])
        expect(input.boundary.systemText).toContain('修复机会仅一次')
        expect(() => input.boundary.validateToolCall('notes_create', {})).toThrow('MODEL_TOOL_NOT_EXPOSED')
        return response(JSON.stringify(draft()))
      })
    const s = setup(request)
    try {
      s.runner.start(); const task = s.accept(); await s.runner.idle()
      expect(request).toHaveBeenCalledTimes(2)
      expect(s.tasks.get(task.taskId).status).toBe('succeeded')
      expect(new R1Items(s.db).list()).toEqual([])
    } finally { await s.close() }
    const invalid = vi.fn(async () => response('{still invalid'))
    const second = setup(invalid)
    try {
      second.runner.start(); const task = second.accept(); await second.runner.idle()
      expect(invalid).toHaveBeenCalledTimes(2)
      expect(second.tasks.get(task.taskId)).toMatchObject({ status: 'failed', result: { unresolved: ['STRUCTURED_OUTPUT_INVALID'] } })
      expect(second.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toMatchObject({ n: 0 })
    } finally { await second.close() }
  })
  it('does not execute same-batch Skill loading and a domain write before another decision', async () => {
    const request = vi.fn(async () => response('', [call('load', 'read_file', { file_path: '/skills/capture-item/SKILL.md' }),
      call('save', 'notes_create', { type: 'note', title: '不应创建', content: '正文', mode: 'organized', sourceRefs: [] })]))
    const s = setup(request)
    try {
      s.runner.start(); const task = s.accept(); await s.runner.idle()
      expect(s.tasks.get(task.taskId)).toMatchObject({ status: 'partially_succeeded', result: { unresolved: ['MODEL_TOOL_NOT_EXPOSED'] } })
      expect(new R1Items(s.db).list()).toEqual([])
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()).toMatchObject({ n: 0 })
    } finally { await s.close() }
  })
  it('allows one tool-free repair of an invented artifact base and assigns the new artifact ID itself', async () => {
    const invalidDraft = { ...draft(), artifacts: [{ ...draft().artifacts[0], baseArtifactId: 'invented-item-id', baseArtifactVersion: 1 }] }
    const request = vi.fn<(input: Request) => Promise<ArkResponse>>().mockResolvedValueOnce(response(JSON.stringify(invalidDraft)))
      .mockImplementation(async input => {
        expect(input.boundary.systemText).toContain('TASK_RESULT_ARTIFACT_INVALID')
        expect(input.boundary.finalize(input.messages).tools).toEqual([])
        return response(JSON.stringify(draft()))
      })
    const s = setup(request)
    try {
      s.runner.start(); const task = s.accept(); await s.runner.idle()
      expect(request).toHaveBeenCalledTimes(2)
      expect(s.tasks.get(task.taskId)).toMatchObject({ status: 'succeeded', result: { artifacts: [{ version: 1 }] } })
      expect(s.tasks.get(task.taskId).result!.artifacts[0].artifactId).not.toBe('invented-item-id')
      expect(new R1Items(s.db).list()).toEqual([])
    } finally { await s.close() }
  })
  it('checks an unknown existing receipt before any resumed model request and never relabels it succeeded', async () => {
    const request = vi.fn(async () => response(JSON.stringify(draft())))
    const s = setup(request)
    try {
      const task = s.accept(); const active = s.tasks.claimNext()!
      const receipt = new R1TaskToolExecutor(s.tasks, assets).execute(active.lease, 'read_file', {
        file_path: '/skills/work-discussion/SKILL.md' })
      s.db.prepare("UPDATE receipts SET status = 'unknown' WHERE action_id = ?").run(receipt.actionId)
      s.tasks.suspend(); s.tasks.wake(); s.tasks.resume(task.taskId, 1)
      s.runner.start(); await s.runner.idle()
      expect(request).not.toHaveBeenCalled()
      expect(s.tasks.get(task.taskId)).toMatchObject({ status: 'partially_succeeded', result: {
        unresolved: ['TASK_RECEIPT_RECONCILIATION_REQUIRED'], entityReceipts: [{ status: 'unknown', actionId: receipt.actionId }] } })
    } finally { await s.close() }
  })
  it('repairs Item/Artifact and call/action ID confusion from actual receipt proofs without repeating the write', async () => {
    let index = 0; let saved!: { actionId: string; entityId: string }
    const request = vi.fn(async (input: Request) => {
      if (index++ === 0) return response('', [call('skill', 'read_file', { file_path: '/skills/capture-item/SKILL.md' })])
      if (index === 2) return response('', [call('note', 'notes_create', { type: 'note', title: '真实事项', content: '已提交', mode: 'organized', sourceRefs: [] })])
      saved = input.rounds?.[1]?.results[0].output as typeof saved ?? saved
      if (index === 3) return response(JSON.stringify({ ...draft(), receiptActionIds: ['note'],
        artifacts: [{ ...draft().artifacts[0], baseArtifactId: saved.entityId, baseArtifactVersion: 1 }] }))
      expect(input.boundary.finalize(input.messages).tools).toEqual([])
      expect(input.boundary.systemText).toContain('receiptProofs')
      expect(input.boundary.systemText).toContain(saved.entityId)
      expect(input.boundary.systemText).toContain(saved.actionId)
      expect(input.boundary.systemText).toContain('"artifactBases":[]')
      return response(JSON.stringify({ ...draft(), artifacts: [], receiptActionIds: [saved.actionId] }))
    })
    const s = setup(request, false, false, [{ alias: 'notes_create', minimumCount: 1 }])
    try {
      s.runner.start(); const task = s.accept(); await s.runner.idle()
      expect(request).toHaveBeenCalledTimes(4)
      expect(s.tasks.get(task.taskId).status).toBe('succeeded')
      expect(new R1Items(s.db).list()).toHaveLength(1)
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE entity_id = ?').get(saved.entityId)).toMatchObject({ n: 1 })
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toMatchObject({ n: 0 })
    } finally { await s.close() }
  })
  it('does not lose an acceptance queued between drain completion and its final cleanup', async () => {
    const request = vi.fn(async () => response(JSON.stringify(draft())))
    const s = setup(request)
    try {
      let secondId = ''
      s.tasks.onChanged(event => {
        if (event.reason === 'completed' && !secondId) queueMicrotask(() => queueMicrotask(() => {
          secondId = s.tasks.accept({ requestKey: 'second', sourceMessageId: s.source.messageId, timezone: 'Asia/Shanghai',
            goal: '第二份工作稿', constraints: [], authorizedAliases: ['read_file'], complexity: 'light' }).taskId
        }))
      })
      s.runner.start(); s.accept(); await s.runner.idle()
      expect(secondId).not.toBe('')
      expect(s.tasks.get(secondId).status).toBe('succeeded')
      expect(request).toHaveBeenCalledTimes(2)
    } finally { await s.close() }
  })
})
