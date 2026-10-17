import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { R1Artifacts } from '../electron/main/r1/artifacts'
import { R1Items } from '../electron/main/r1/items'
import { R1TaskToolExecutor } from '../electron/main/r1/taskToolExecutor'
const assets = loadR1PromptAssets(resolve('r1-assets'))
function setup() {
  const db = openR1Database(':memory:')
  const conversation = new R1Conversations(db)
  const sessionId = conversation.start()
  const source = conversation.append({ sessionId, turnId: 'turn', role: 'user', body: '帮我整理一份讨论稿', status: 'final' })
  let clock = 0; let epoch = 0
  const supervisor = new R1TaskSupervisor(db, assets, () => epoch, { clock: () => clock })
  const request = { requestKey: 'request', sourceMessageId: source.messageId, timezone: 'Asia/Shanghai',
    goal: '整理讨论稿', constraints: [], authorizedAliases: ['read_file', 'write_todos', 'notes_create'], complexity: 'complex' as const }
  return { db, conversation, source, supervisor, request, time: (value: number) => { clock = value }, forget: () => { epoch++ } }
}
const draft = (goalVersion = 1) => ({ status: 'completed', goalVersion, replyBrief: '讨论稿已整理', sourceRefs: [],
  receiptActionIds: [], artifacts: [{ kind: 'text', title: '讨论稿', content: '真实生成的内容', baseArtifactId: null,
    baseArtifactVersion: null, sourceRefs: [] }], candidates: [], unresolved: [] })
describe('R1 TaskSupervisor identity, recovery and result publication', () => {
  it('rejects a completed web investigation without actual included source receipts even if requiredActions is empty', () => {
    const { db, supervisor, request } = setup()
    try {
      supervisor.accept({ ...request, authorizedAliases: ['read_file', 'web_search', 'web_read_page'], requiredActions: [] })
      const active = supervisor.claimNext()!
      const output = { ...draft(), artifacts: [], sourceRefs: [request.sourceMessageId], replyBrief: '凭记忆附一个链接 https://example.org' }
      expect(() => supervisor.publish(active.lease, output, new R1Artifacts(db))).toThrow('TASK_COMPLETION_WEB_EVIDENCE_MISSING')
      expect(supervisor.list()[0].status).toBe('running')
      expect(supervisor.publish(active.lease, { ...output, status: 'partial', replyBrief: '尚未联网核验', unresolved: ['没有实际来源'] }, new R1Artifacts(db)).completionStatus).toBe('partial')
    } finally { supervisor.close(); db.close() }
  })
  it('returns accepted idempotently, allows one running task and at most three queued tasks', () => {
    const { db, supervisor, request } = setup()
    try {
      const first = supervisor.accept(request)
      expect(first).toMatchObject({ status: 'accepted', goalVersion: 1, queuePosition: 0, result: null })
      expect(supervisor.accept(request).taskId).toBe(first.taskId)
      const running = supervisor.claimNext()!
      expect(running.lease.taskId).toBe(first.taskId)
      for (let i = 1; i <= 3; i++) expect(supervisor.accept({ ...request, requestKey: `queued-${i}` }).queuePosition).toBe(i)
      expect(() => supervisor.accept({ ...request, requestKey: 'overflow' })).toThrow('TASK_QUEUE_FULL')
      expect(supervisor.claimNext()).toBeNull()
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get()).toMatchObject({ n: 4 })
      expect(() => supervisor.accept({ ...request, goal: 'changed' })).toThrow('TASK_REQUEST_KEY_REUSED')
    } finally { supervisor.close(); db.close() }
  })
  it('waits for a safe pause, consumes monotonic active budget and gives resume a new run ID', () => {
    const { db, supervisor, request, time } = setup()
    try {
      const task = supervisor.accept(request); const running = supervisor.claimNext()!
      time(1000)
      expect(supervisor.beginDecision(running.lease).budget.activeMsRemaining).toBe(119000)
      expect(supervisor.get(task.taskId).budget.decisionsRemaining).toBe(7)
      expect(supervisor.pause(task.taskId, 1).status).toBe('running')
      expect(running.signal.aborted).toBe(true)
      expect(() => supervisor.beginDecision(running.lease)).toThrow('TASK_NOT_RUNNING')
      supervisor.settlePause(running.lease)
      time(50000)
      expect(supervisor.get(task.taskId)).toMatchObject({ status: 'paused', budget: { activeMsRemaining: 119000 } })
      supervisor.resume(task.taskId, 1)
      const next = supervisor.claimNext()!
      expect(next.lease.runId).not.toBe(running.lease.runId)
      expect(() => supervisor.assertLease(running.lease)).toThrow('TASK_CONTEXT_STALE')
    } finally { supervisor.close(); db.close() }
  })
  it('keeps original source time/timezone and cancels old goal publication on steer or forget', () => {
    const { db, supervisor, request, conversation, source, forget } = setup()
    try {
      const task = supervisor.accept(request); const first = supervisor.claimNext()!
      const checkpoint = JSON.parse((db.prepare('SELECT checkpoint_json FROM agent_tasks WHERE task_id = ?').get(task.taskId) as { checkpoint_json: string }).checkpoint_json)
      expect(checkpoint.source).toMatchObject({ createdAt: source.createdAt, timezone: 'Asia/Shanghai' })
      const updated = conversation.append({ sessionId: source.sessionId, turnId: 'next', role: 'user', body: '改成更短的稿件', status: 'final' })
      supervisor.steer({ taskId: task.taskId, expectedGoalVersion: 1, goal: '更短的稿件', constraints: [], sourceMessageId: updated.messageId })
      expect(first.signal.aborted).toBe(true)
      expect(supervisor.get(task.taskId).goalVersion).toBe(2)
      expect(supervisor.accept(request)).toMatchObject({ taskId: task.taskId, goalVersion: 2, goal: '更短的稿件' })
      expect(() => supervisor.accept({ ...request, authorizedAliases: ['read_file'] })).toThrow('TASK_REQUEST_KEY_REUSED')
      expect(() => supervisor.accept({ ...request, timezone: 'UTC' })).toThrow('TASK_REQUEST_KEY_REUSED')
      expect(() => supervisor.accept({ ...request, complexity: 'light' })).toThrow('TASK_REQUEST_KEY_REUSED')
      const next = supervisor.claimNext()!
      expect(() => supervisor.publish(first.lease, draft(), new R1Artifacts(db))).toThrow('TASK_CONTEXT_STALE')
      forget()
      expect(() => supervisor.beginDecision(next.lease)).toThrow('TASK_CONTEXT_STALE')
      supervisor.invalidateContext()
      expect(supervisor.get(task.taskId).status).toBe('needs_resume')
      expect(() => supervisor.resume(task.taskId, 2)).toThrow('TASK_CONTEXT_REVALIDATION_REQUIRED')
    } finally { supervisor.close(); db.close() }
  })
  it('preserves a real committed item on cancel and rejects fake or unknown success receipts', () => {
    const { db, supervisor, request } = setup()
    try {
      const task = supervisor.accept(request); const running = supervisor.claimNext()!
      supervisor.loadSkill(running.lease, 'SK03')
      const actionId = supervisor.consumeTool(running.lease, 'notes_create')
      const item = new R1Items(db).create({ actionId, kind: 'note', title: '已提交', body: '真实正文' }).item
      supervisor.recordReceipt(running.lease, actionId)
      expect(() => supervisor.recordReceipt(running.lease, 'fake-action')).toThrow('TASK_RECEIPT_NOT_VERIFIED')
      const result = { ...draft(), artifacts: [], receiptActionIds: [actionId] }
      db.prepare("UPDATE receipts SET status = 'unknown' WHERE action_id = ?").run(actionId)
      expect(() => supervisor.publish(running.lease, result, new R1Artifacts(db))).toThrow('TASK_COMPLETION_INCONSISTENT')
      supervisor.cancel(task.taskId, 1)
      expect(supervisor.get(task.taskId).status).toBe('cancelled')
      expect(new R1Items(db).list()[0].itemId).toBe(item.itemId)
      expect(() => supervisor.publish(running.lease, result, new R1Artifacts(db))).toThrow('TASK_NOT_RUNNING')
    } finally { supervisor.close(); db.close() }
  })
  it('publishes real artifact versions and IDs once after schema/source checks', () => {
    const { db, supervisor, request } = setup()
    try {
      const task = supervisor.accept(request); const running = supervisor.claimNext()!
      const artifacts = new R1Artifacts(db)
      expect(() => supervisor.publish(running.lease, { ...draft(), sourceRefs: ['invented-source'] }, artifacts)).toThrow('TASK_RESULT_SOURCE_INVALID')
      const result = supervisor.publish(running.lease, draft(), artifacts)
      expect(result.artifacts).toHaveLength(1)
      expect(result.entityReceipts[0]).toMatchObject({ status: 'succeeded', entityId: result.artifacts[0].artifactId })
      expect(supervisor.publish(running.lease, draft(), artifacts)).toEqual(result)
      expect(supervisor.get(task.taskId)).toMatchObject({ status: 'succeeded', resultId: result.resultId })
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_versions').get()).toMatchObject({ n: 1 })
      expect(db.prepare('SELECT status FROM task_runs WHERE run_id = ?').get(running.lease.runId)).toMatchObject({ status: 'succeeded' })
    } finally { supervisor.close(); db.close() }
  })
  it('requires real delegated write receipts, while optional internal reads need not be listed as user results', () => {
    const { db, supervisor, request } = setup()
    try {
      supervisor.accept({ ...request, requiredActions: [{ alias: 'notes_create', minimumCount: 1 }] })
      const active = supervisor.claimNext()!
      const executor = new R1TaskToolExecutor(supervisor, assets, new R1Items(db))
      const read = executor.execute(active.lease, 'read_file', { file_path: '/skills/capture-item/SKILL.md' })
      expect(() => supervisor.publish(active.lease, { ...draft(), artifacts: [], receiptActionIds: [read.actionId] }, new R1Artifacts(db)))
        .toThrow('TASK_COMPLETION_REQUIRED_RECEIPT_MISSING')
      const saved = executor.execute(active.lease, 'notes_create', { type: 'note', title: '真实便签', content: '正文', mode: 'organized', sourceRefs: [] })
      const published = supervisor.publish(active.lease, { ...draft(), artifacts: [], receiptActionIds: [saved.actionId] }, new R1Artifacts(db))
      expect(published.entityReceipts).toMatchObject([{ actionId: saved.actionId, entityId: saved.entityId, status: 'succeeded' }])
      expect(new R1Items(db).list()).toHaveLength(1)
    } finally { supervisor.close(); db.close() }
  })
  it('restores ordinary interrupted tasks to needs_resume and never writes temporary task bodies', () => {
    const { db, supervisor, request } = setup()
    try {
      const task = supervisor.accept(request); supervisor.claimNext()
      supervisor.close()
      const reopened = new R1TaskSupervisor(db, assets, () => 0)
      expect(reopened.get(task.taskId).status).toBe('needs_resume')
      expect(reopened.accept(request).taskId).toBe(task.taskId)
      expect(reopened.claimNext()).toBeNull()
      reopened.close()
      const temporary = new R1TaskSupervisor(db, assets, () => 0, { temporarySource: id => id === 'temp-source' ? {
        messageId: id, sessionId: 'temp-session', turnId: 'temp-turn', body: '临时私密正文', createdAt: new Date().toISOString(),
        timezone: 'Asia/Shanghai', temporary: true } : undefined })
      const temp = temporary.accept({ ...request, requestKey: 'temporary', sourceMessageId: 'temp-source', goal: '临时私密正文' })
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get()).toMatchObject({ n: 1 })
      const active = temporary.claimNext()!; temporary.loadSkill(active.lease, 'SK06')
      temporary.publish(active.lease, draft(), new R1Artifacts(db))
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toMatchObject({ n: 0 })
      temporary.endTemporary('temp-session')
      expect(() => temporary.get(temp.taskId)).toThrow('TASK_NOT_FOUND')
      temporary.close()
    } finally { db.close() }
  })
  it('validates plan dependencies without creating user Todos and pauses on system suspend', () => {
    const { db, supervisor, request } = setup()
    try {
      const task = supervisor.accept(request); const active = supervisor.claimNext()!
      const step = { stepId: 'step', action: '整理', dependsOn: [], status: 'pending' as const, successCondition: '产物已提交' }
      expect(supervisor.updatePlan(active.lease, [step]).planVersion).toBe(1)
      expect(new R1Items(db).list()).toEqual([])
      expect(() => supervisor.updatePlan(active.lease, [{ ...step, dependsOn: ['missing'] }])).toThrow('TASK_PLAN_DEPENDENCY_INVALID')
      expect(() => supervisor.updatePlan(active.lease, [step, { ...step, stepId: 'step2', dependsOn: ['step'] },
        { ...step, stepId: 'step', dependsOn: ['step2'] }])).toThrow('TASK_PLAN_DEPENDENCY_INVALID')
      expect(() => supervisor.updatePlan(active.lease, [{ ...step, dependsOn: ['step2'] },
        { ...step, stepId: 'step2', dependsOn: ['step'] }])).toThrow('TASK_PLAN_CYCLE')
      supervisor.suspend(); supervisor.wake()
      expect(active.signal.aborted).toBe(true)
      expect(supervisor.get(task.taskId).status).toBe('needs_resume')
      expect(supervisor.claimNext()).toBeNull()
    } finally { supervisor.close(); db.close() }
  })
})

function webSetup() {
  const db = openR1Database(':memory:')
  const conversation = new R1Conversations(db)
  const sessionId = conversation.start()
  const source = conversation.append({ sessionId, turnId: 'turn', role: 'user', body: '查一下 RFC 9110 官方标准', status: 'final' })
  const supervisor = new R1TaskSupervisor(db, assets, () => 0)
  const now = new Date().toISOString()
  const candidate = { candidateId: 'c1', title: 'RFC 9110: HTTP Semantics', url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
    snippet: 'HTTP semantics specification', query: 'RFC 9110', queriedAtUtc: now, pageDate: '2022-06-01', readDepth: 'search_summary' as const }
  const search = { async search() { return { query: 'RFC 9110', queriedAtUtc: now, moreResultsAvailable: false, candidates: [candidate] } } }
  const executor = new R1TaskToolExecutor(supervisor, assets, undefined, search)
  return { db, supervisor, source, executor, candidate }
}
const webDraft = (actionId: string, overrides: Record<string, unknown> = {}) => ({ status: 'completed', goalVersion: 1,
  replyBrief: 'RFC 9110 是当前的 HTTP 语义标准。', sourceRefs: ['source:c1'], receiptActionIds: [actionId],
  artifacts: [], candidates: [{ candidateId: 'c1', label: 'RFC 9110: HTTP Semantics',
    summary: 'HTTP semantics specification', sourceRefs: ['source:c1'] }], unresolved: [], ...overrides })

describe('web completion contract', () => {
  it('completes from a cited search summary without forcing an authorized page read', async () => {
    const s = webSetup()
    try {
      const task = s.supervisor.accept({ requestKey: 'web', sourceMessageId: s.source.messageId, timezone: 'Asia/Shanghai',
        goal: '查 RFC 9110', constraints: [], authorizedAliases: ['read_file', 'web_search', 'web_read_page'], complexity: 'complex' })
      const active = s.supervisor.claimNext()!
      s.executor.execute(active.lease, 'read_file', { file_path: '/skills/web-qa/SKILL.md' }, 'skill')
      const receipt = await s.executor.executeAsync(active.lease, 'web_search', { query: 'RFC 9110' }, 'call')
      expect(receipt.status).toBe('succeeded')
      const result = s.supervisor.publish(active.lease, webDraft((receipt as { actionId: string }).actionId), new R1Artifacts(s.db))
      expect(result.completionStatus).toBe('completed')
      expect(s.supervisor.get(task.taskId).status).toBe('succeeded')
    } finally { s.supervisor.close(); s.db.close() }
  })
  it('accepts evidence cited only through a candidate and rejects unrelated or unlisted sources', async () => {
    const s = webSetup()
    try {
      const task = s.supervisor.accept({ requestKey: 'web-2', sourceMessageId: s.source.messageId, timezone: 'Asia/Shanghai',
        goal: '查 RFC 9110', constraints: [], authorizedAliases: ['read_file', 'web_search', 'web_read_page'], complexity: 'complex' })
      const active = s.supervisor.claimNext()!
      s.executor.execute(active.lease, 'read_file', { file_path: '/skills/web-qa/SKILL.md' }, 'skill')
      const receipt = await s.executor.executeAsync(active.lease, 'web_search', { query: 'RFC 9110' }, 'call')
      const actionId = (receipt as { actionId: string }).actionId
      expect(() => s.supervisor.publish(active.lease, webDraft(actionId, { sourceRefs: [], candidates: [{ candidateId: 'c1',
        label: 'RFC 9110', summary: 'HTTP semantics specification', sourceRefs: ['source:c1'] }] }), new R1Artifacts(s.db)))
        .not.toThrow()
      // A second task cannot complete by citing a source it never received.
      const other = s.supervisor.accept({ requestKey: 'web-3', sourceMessageId: s.source.messageId, timezone: 'Asia/Shanghai',
        goal: '另一个查询', constraints: [], authorizedAliases: ['read_file', 'web_search'], complexity: 'complex' })
      const otherActive = s.supervisor.claimNext()!
      expect(() => s.supervisor.publish(otherActive.lease, webDraft(actionId, { sourceRefs: ['source:unrelated'] }), new R1Artifacts(s.db)))
        .toThrow('TASK_COMPLETION_WEB_EVIDENCE_MISSING')
      expect(s.supervisor.get(other.taskId).status).toBe('running')
    } finally { s.supervisor.close(); s.db.close() }
  })
  it('still requires a real page read when the user explicitly required one', async () => {
    const s = webSetup()
    try {
      s.supervisor.accept({ requestKey: 'web-read', sourceMessageId: s.source.messageId, timezone: 'Asia/Shanghai',
        goal: '读 RFC 9110 原文核验', constraints: [], authorizedAliases: ['read_file', 'web_search', 'web_read_page'],
        complexity: 'complex', requiredActions: [{ alias: 'web_read_page', minimumCount: 1 }] })
      const active = s.supervisor.claimNext()!
      s.executor.execute(active.lease, 'read_file', { file_path: '/skills/web-qa/SKILL.md' }, 'skill')
      const receipt = await s.executor.executeAsync(active.lease, 'web_search', { query: 'RFC 9110' }, 'call')
      expect(() => s.supervisor.publish(active.lease, webDraft((receipt as { actionId: string }).actionId), new R1Artifacts(s.db)))
        .toThrow('TASK_COMPLETION_REQUIRED_RECEIPT_MISSING')
      const partial = s.supervisor.publish(active.lease, webDraft((receipt as { actionId: string }).actionId,
        { status: 'partial', unresolved: ['未读取原文'] }), new R1Artifacts(s.db))
      expect(partial.completionStatus).toBe('partial')
    } finally { s.supervisor.close(); s.db.close() }
  })
})
