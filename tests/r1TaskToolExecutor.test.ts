import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1TaskToolExecutor } from '../electron/main/r1/taskToolExecutor'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { R1Items } from '../electron/main/r1/items'
const assets = loadR1PromptAssets(resolve('r1-assets'))
describe('controlled internal task tools', () => {
  it('loads only complete registered Skill bodies, records real receipts and rejects host/cross-task paths', () => {
    const db = openR1Database(':memory:')
    const conversations = new R1Conversations(db)
    const sessionId = conversations.start()
    const message = conversations.append({ sessionId, turnId: 'source', role: 'user', body: '整理讨论稿', status: 'final' })
    const tasks = new R1TaskSupervisor(db, assets, () => 0)
    try {
      const task = tasks.accept({ requestKey: 'request', sourceMessageId: message.messageId, timezone: 'Asia/Shanghai',
        goal: '整理讨论稿', constraints: [], authorizedAliases: ['read_file', 'write_todos'], complexity: 'complex' })
      const active = tasks.claimNext()!
      const executor = new R1TaskToolExecutor(tasks, assets)
      const partial = executor.execute(active.lease, 'read_file', { file_path: '/skills/work-discussion/SKILL.md', limit: 1 })
      expect(partial.status).toBe('succeeded')
      expect(tasks.beginDecision(active.lease).loadedSkillIds).toEqual([])
      const complete = executor.execute(active.lease, 'read_file', { file_path: '/skills/work-discussion/SKILL.md' })
      expect(complete.data.content).toContain('生成可编辑ArtifactDraft')
      expect(tasks.beginDecision(active.lease).loadedSkillIds).toEqual(['SK06'])
      expect(executor.execute(active.lease, 'read_file', { file_path: '/Users/sea/.env' })).toMatchObject({ status: 'failed', errorCode: 'SKILL_FILE_SCOPE_INVALID' })
      expect(executor.execute(active.lease, 'read_file', { file_path: '/skills/work-discussion/../../.env' })).toMatchObject({ status: 'failed' })
      expect(executor.execute(active.lease, 'read_file', { file_path: '/task/other/source-turn.json' })).toMatchObject({ status: 'failed' })
      const source = executor.execute(active.lease, 'read_file', { file_path: `/task/${task.taskId}/source-turn.json` })
      expect(JSON.parse(source.data.content as string)).toMatchObject({ body: message.body, createdAt: message.createdAt, timezone: 'Asia/Shanghai' })
      expect(db.prepare('SELECT status, task_id FROM receipts WHERE action_id = ?').get(complete.actionId))
        .toMatchObject({ status: 'succeeded', task_id: task.taskId })
      expect(tasks.get(task.taskId).budget.toolsRemaining).toBe(6)
    } finally { tasks.close(); db.close() }
  })
  it('rolls back a domain write and its state when output validation fails, returning a real failed receipt', () => {
    const db = openR1Database(':memory:')
    const conversations = new R1Conversations(db)
    const message = conversations.append({ sessionId: conversations.start(), turnId: 'source', role: 'user', body: '明确保存事项', status: 'final' })
    const rejectingAssets = { ...assets, validateToolOutput(alias: string, output: unknown) {
      if ((output as { status: string }).status === 'succeeded') throw new Error('MODEL_TOOL_OUTPUT_DATA_INVALID')
      assets.validateToolOutput(alias, output)
    } }
    const tasks = new R1TaskSupervisor(db, rejectingAssets, () => 0)
    try {
      tasks.accept({ requestKey: 'request', sourceMessageId: message.messageId, timezone: 'Asia/Shanghai',
        goal: message.body, constraints: [], authorizedAliases: ['notes_create', 'write_todos'], complexity: 'complex' })
      const active = tasks.claimNext()!; tasks.loadSkill(active.lease, 'SK03')
      const executor = new R1TaskToolExecutor(tasks, rejectingAssets, new R1Items(db))
      const result = executor.execute(active.lease, 'notes_create', { type: 'note', title: '不能残留', content: '正文', mode: 'organized', sourceRefs: [message.messageId] })
      expect(result).toMatchObject({ status: 'failed', errorCode: 'MODEL_TOOL_OUTPUT_DATA_INVALID', entityId: null })
      expect(new R1Items(db).list()).toEqual([])
      expect(db.prepare('SELECT status FROM receipts WHERE action_id = ?').get(result.actionId)).toMatchObject({ status: 'failed' })
      let planEvents = 0; tasks.onChanged(event => { if (event.reason === 'plan') planEvents++ })
      const plan = executor.execute(active.lease, 'write_todos', { steps: [{ stepId: 'one', action: '整理', dependsOn: [], status: 'pending', successCondition: '说明已生成' }] })
      expect(plan.status).toBe('failed'); expect(planEvents).toBe(0)
      expect(tasks.get(active.lease.taskId).planVersion).toBe(0)
    } finally { tasks.close(); db.close() }
  })
  it('rejects invented sources and only permits temporary persistence from a trusted confirmation', () => {
    for (const confirmed of [false, true]) {
      const db = openR1Database(':memory:')
      const source = { messageId: 'temp', sessionId: 'temporary', turnId: 'turn', body: '临时原话', createdAt: new Date().toISOString(), timezone: 'Asia/Shanghai', temporary: true }
      const tasks = new R1TaskSupervisor(db, assets, () => 0, { temporarySource: id => id === 'temp' ? source : undefined })
      try {
        const task = tasks.accept({ requestKey: 'request', sourceMessageId: 'temp', timezone: 'Asia/Shanghai',
          goal: '保存临时原话', constraints: [], authorizedAliases: ['notes_create'], complexity: 'complex', persistenceConfirmed: confirmed })
        const active = tasks.claimNext()!; tasks.loadSkill(active.lease, 'SK03')
        const executor = new R1TaskToolExecutor(tasks, assets, new R1Items(db))
        const args = { type: 'note', title: '明确保存', content: '临时原话', mode: 'original', sourceRefs: ['temp'] }
        const result = executor.execute(active.lease, 'notes_create', args)
        expect(result.status).toBe(confirmed ? 'succeeded' : 'failed')
        if (confirmed) {
          expect(result.data).toMatchObject({ item: { sourceRefs: ['temp'] } })
          db.prepare("UPDATE receipts SET status = 'unknown' WHERE action_id = ?").run(result.actionId)
          expect(() => tasks.readReceipt(active.lease, result.actionId)).toThrow('TASK_RECEIPT_RECONCILIATION_REQUIRED')
          db.prepare("UPDATE receipts SET status = 'succeeded' WHERE action_id = ?").run(result.actionId)
          expect(executor.execute(active.lease, 'notes_create', { ...args, sourceRefs: ['invented'] }))
            .toMatchObject({ status: 'failed', errorCode: 'TASK_TOOL_SOURCE_INVALID' })
          expect(db.prepare('SELECT COUNT(*) AS n FROM receipts').get()).toMatchObject({ n: 1 })
        } else expect(result.errorCode).toBe('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
        tasks.endTemporary('temporary')
        expect(new R1Items(db).list()).toHaveLength(confirmed ? 1 : 0)
        expect(() => tasks.get(task.taskId)).toThrow('TASK_NOT_FOUND')
        expect(db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get()).toMatchObject({ n: 0 })
      } finally { tasks.close(); db.close() }
    }
  })
  it('reuses the original action for the same protocol call and rejects changed arguments under that call ID', () => {
    const db = openR1Database(':memory:')
    const conversations = new R1Conversations(db)
    const message = conversations.append({ sessionId: conversations.start(), turnId: 'source', role: 'user', body: '保存便签', status: 'final' })
    const tasks = new R1TaskSupervisor(db, assets, () => 0)
    try {
      tasks.accept({ requestKey: 'request', sourceMessageId: message.messageId, timezone: 'Asia/Shanghai', goal: message.body,
        constraints: [], authorizedAliases: ['notes_create'], complexity: 'complex' })
      const active = tasks.claimNext()!; tasks.loadSkill(active.lease, 'SK03')
      const executor = new R1TaskToolExecutor(tasks, assets, new R1Items(db))
      const args = { type: 'note', title: '原便签', content: '正文', mode: 'organized', sourceRefs: [message.messageId] }
      const first = executor.execute(active.lease, 'notes_create', args, 'original-call')
      const repeated = executor.execute(active.lease, 'notes_create', { sourceRefs: args.sourceRefs, mode: args.mode,
        content: args.content, title: args.title, type: args.type }, 'original-call')
      expect(repeated).toEqual(first)
      expect(new R1Items(db).list()).toHaveLength(1)
      expect(() => executor.execute(active.lease, 'notes_create', { ...args, content: '另一内容' }, 'original-call')).toThrow('TASK_TOOL_CALL_ID_REUSED')
      expect(db.prepare('SELECT COUNT(*) AS n FROM receipts').get()).toMatchObject({ n: 1 })
      // A different accepted protocol call is a distinct action, even with identical content.
      executor.execute(active.lease, 'notes_create', args, 'distinct-call')
      expect(new R1Items(db).list()).toHaveLength(2)
    } finally { tasks.close(); db.close() }
  })
})

it.each(['brave', 'doubao'] as const)('runs %s search through the task budget, records real sources, and drops results after cancellation', async providerName => {
  const { createBraveSearchProvider } = await import('../electron/main/providers/braveSearchProvider')
  const { createDoubaoSearchProvider } = await import('../electron/main/providers/doubaoSearchProvider')
  const db = openR1Database(':memory:')
  const conversations = new R1Conversations(db), sessionId = conversations.start()
  const source = conversations.append({ sessionId, turnId: 'search-source', role: 'user', body: '查询安静的公园', status: 'final' })
  const tasks = new R1TaskSupervisor(db, assets, () => 0)
  let requests = 0, release: (() => void) | undefined
  const createProvider = providerName === 'doubao' ? createDoubaoSearchProvider : createBraveSearchProvider
  const provider = createProvider({ key: () => 'synthetic', fetcher: (async () => {
    requests++
    if (requests === 2) await new Promise<void>(resolve => { release = resolve })
    return new Response(JSON.stringify(providerName === 'doubao'
      ? { Result: { ResultCount: 1, WebResults: [{ Title: '官方公园介绍', Url: 'https://example.com/park', Summary: '搜索摘要，尚未读页面', PublishTime: '2026-10-16T08:00:00Z' }] } }
      : { web: { results: [{ title: '官方公园介绍', url: 'https://example.com/park', description: '搜索摘要，尚未读页面' }] } }), { status: 200 })
  }) as typeof fetch })
  const executor = new R1TaskToolExecutor(tasks, assets, undefined, provider)
  try {
    tasks.accept({ requestKey: 'search', sourceMessageId: source.messageId, timezone: 'Asia/Shanghai', goal: '查询公园',
      constraints: [], authorizedAliases: ['read_file', 'web_search'], complexity: 'complex' })
    const active = tasks.claimNext()!
    executor.execute(active.lease, 'read_file', { file_path: '/skills/web-qa/SKILL.md' })
    const result = await executor.executeAsync(active.lease, 'web_search', { query: '公园' }, 'call-one')
    expect(result.status).toBe('succeeded')
    const sources = result.data.sources as Array<{ sourceRef: string; readStatus: string }>
    expect(sources[0].readStatus).toBe('not_read')
    expect(tasks.beginDecision(active.lease).sourceRefs).toContain(sources[0].sourceRef)
    expect(tasks.readReceipt(active.lease, result.actionId)).toEqual(result)
    await executor.executeAsync(active.lease, 'web_search', { query: '公园' }, 'call-one')
    expect(requests).toBe(1)
    const pending = executor.executeAsync(active.lease, 'web_search', { query: '第二个地点' }, 'call-two')
    tasks.cancel(active.lease.taskId, active.lease.goalVersion)
    release?.()
    await expect(pending).rejects.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM receipts WHERE task_id = ?').get(active.lease.taskId)).toMatchObject({ n: 2 })
  } finally { tasks.close(); db.close() }
})

it('binds page reading to an existing source and exposes persisted search and page evidence to the task view', async () => {
  const { createPageReader } = await import('../electron/main/providers/pageReader')
  const { createBraveSearchProvider } = await import('../electron/main/providers/braveSearchProvider')
  const db = openR1Database(':memory:')
  const conversations = new R1Conversations(db), sessionId = conversations.start()
  const message = conversations.append({ sessionId, turnId: 'source', role: 'user', body: '查并读取介绍', status: 'final' })
  const tasks = new R1TaskSupervisor(db, assets, () => 0)
  try {
    const search = createBraveSearchProvider({ key: () => 'synthetic', fetcher: (async () => new Response(JSON.stringify({ web: { results: [
      { title: '介绍', url: 'https://example.org/park', description: '摘要' }
    ] } }))) as typeof fetch })
    let pageRequests = 0
    const pages = createPageReader({ read: async url => { pageRequests++; return { url: url.href, bytes: Buffer.from('<title>介绍</title><main>实际页面正文</main>'), contentType: 'text/html', truncated: false } } })
    const task = tasks.accept({ requestKey: 'page', sourceMessageId: message.messageId, timezone: 'Asia/Shanghai', goal: '读取页面',
      constraints: [], authorizedAliases: ['read_file', 'web_search', 'web_read_page'], complexity: 'complex' })
    const active = tasks.claimNext()!, executor = new R1TaskToolExecutor(tasks, assets, undefined, search, pages)
    executor.execute(active.lease, 'read_file', { file_path: '/skills/web-qa/SKILL.md' })
    await executor.executeAsync(active.lease, 'web_search', { query: '介绍' }, 'search')
    const sourceRef = tasks.get(task.taskId).webResult!.sources[0].sourceRef
    expect(() => tasks.assertPageSource(active.lease, sourceRef, 'https://example.org/park#chapter')).not.toThrow()
    expect(() => tasks.assertPageSource(active.lease, sourceRef, 'https://example.org/park?different=true#chapter')).toThrow('TASK_PAGE_SOURCE_INVALID')
    await expect(executor.executeAsync(active.lease, 'web_read_page', { url: 'https://example.org/other', sourceRef, fields: [] }, 'wrong'))
      .resolves.toMatchObject({ status: 'failed', errorCode: 'TASK_PAGE_SOURCE_INVALID' })
    expect(pageRequests).toBe(0)
    const result = await executor.executeAsync(active.lease, 'web_read_page', { url: 'https://example.org/park', sourceRef, fields: ['title'] }, 'page')
    expect(result.status).toBe('succeeded')
    expect(tasks.get(task.taskId).webResult).toMatchObject({ sources: [{ sourceRef, readStatus: 'read', snippet: '实际页面正文' }], candidates: [{ label: '介绍' }] })
    expect(tasks.beginDecision(active.lease).observations.find(item => item.refId === sourceRef)?.resourcePath).toContain(result.actionId)
  } finally { tasks.close(); db.close() }
})

it('saves a chosen real candidate once, keeps source scope, and leaves the note intact if reminder creation fails', async () => {
  const { createBraveSearchProvider } = await import('../electron/main/providers/braveSearchProvider')
  const db = openR1Database(':memory:')
  const conversations = new R1Conversations(db), sessionId = conversations.start()
  const source = conversations.append({ sessionId, turnId: 'source', role: 'user', body: '查公园并记下来', status: 'final' })
  const tasks = new R1TaskSupervisor(db, assets, () => 0), items = new R1Items(db)
  try {
    const search = createBraveSearchProvider({ key: () => 'synthetic', fetcher: (async () => new Response(JSON.stringify({ web: { results: [
      { title: '公园', url: 'https://example.org/park', description: '实际搜索摘要' }
    ] } }))) as typeof fetch })
    const task = tasks.accept({ requestKey: 'save-search', sourceMessageId: source.messageId, timezone: 'Asia/Shanghai', goal: '查公园',
      constraints: [], authorizedAliases: ['read_file', 'web_search'], complexity: 'complex' })
    const active = tasks.claimNext()!, executor = new R1TaskToolExecutor(tasks, assets, items, search)
    executor.execute(active.lease, 'read_file', { file_path: '/skills/web-qa/SKILL.md' })
    await executor.executeAsync(active.lease, 'web_search', { query: '公园' }, 'search')
    const candidateId = tasks.get(task.taskId).webResult!.candidates[0].candidateId
    const { selectedConversationEntity, currentCandidateContext } = await import('../electron/main/r1/sessionMode')
    const mode = { temporary: false, sessionId, selectedCandidate: { taskId: task.taskId, goalVersion: task.goalVersion, candidateId, candidateVersion: tasks.candidateVersion(task.taskId, candidateId) } }
    expect(selectedConversationEntity(mode, tasks)).toEqual({ type: 'candidate', id: candidateId, version: 1 })
    expect(selectedConversationEntity({ ...mode, selectedCandidate: { ...mode.selectedCandidate, candidateVersion: 999 } }, tasks)).toBeNull()
    expect(selectedConversationEntity({ ...mode, temporary: true }, tasks)).toBeNull()
    const selected = currentCandidateContext(mode, tasks)!
    expect(selected).toMatchObject({ candidate: { candidateId, label: '公园' }, sources: [{ snippet: '实际搜索摘要', readStatus: 'not_read' }] })
    const { R1ConversationTools } = await import('../electron/main/r1/conversationTools')
    const followUp = conversations.append({ sessionId, turnId: 'save-current', role: 'user', body: '把选中的公园记下来，稍后提醒我', status: 'final' })
    const tools = new R1ConversationTools(db, assets, tasks, { source: followUp, temporary: false, timezone: 'Asia/Shanghai',
      selectedCandidate: selected, persistenceConfirmed: false, assertCurrent() {} }, ['read_file', 'web_search'])
    tools.execute('load_skill', { skillId: 'SK03' }, 'load-save')
    const args = { type: 'note', title: '周末的公园', content: '模型不能覆盖真实来源', mode: 'original',
      sourceRefs: selected.candidate.sourceRefs, candidateTarget: mode.selectedCandidate }
    const firstSave = tools.execute('notes_create', args, 'voice-save')
    expect(firstSave).toMatchObject({ status: 'succeeded', data: { item: { sourceRefs: selected.candidate.sourceRefs } } })
    expect(JSON.stringify(firstSave)).toContain('实际搜索摘要')
    expect(JSON.stringify(firstSave)).not.toContain('模型不能覆盖真实来源')
    expect(tools.execute('notes_create', { ...args, candidateTarget: { ...args.candidateTarget, candidateId: 'invented' } }, 'bad-target'))
      .toMatchObject({ status: 'failed', errorCode: 'CANDIDATE_SELECTION_MISMATCH' })
    expect(tools.execute('notes_create', { ...args, sourceRefs: ['invented'] }, 'bad-ref'))
      .toMatchObject({ status: 'failed', errorCode: 'CONVERSATION_SOURCE_NOT_AVAILABLE' })
    expect(tools.execute('notes_create', { ...args, mode: 'organized' }, 'bad-mode'))
      .toMatchObject({ status: 'failed', errorCode: 'CANDIDATE_SAVE_MODE_INVALID' })
    const command = { taskId: task.taskId, expectedGoalVersion: task.goalVersion, candidateId, title: '周末的公园' }
    const saved = tasks.saveCandidate(command)
    expect(saved.itemId).toBe(firstSave.entityId)
    expect(tools.execute('notes_create', args, 'repeat-another-call')).toMatchObject({ entityId: saved.itemId })
    expect(tasks.saveCandidate(command)).toEqual(saved)
    expect(items.list()).toHaveLength(1)
    expect(items.list()[0].body).toContain('仅搜索摘要')
    expect(() => tasks.saveCandidate({ ...command, candidateId: 'invented' })).toThrow('TASK_CANDIDATE_NOT_FOUND')
    expect(() => tasks.saveCandidate({ ...command, expectedGoalVersion: 999 })).toThrow('VERSION_CONFLICT')
    expect(() => items.createReminder({ actionId: 'bad-reminder', itemId: saved.itemId, linkPurpose: 'independent', body: '去公园', dueAtUtc: 'past', timezone: 'Asia/Shanghai' })).toThrow('INVALID_DUE_TIME')
    expect(items.list()[0].itemId).toBe(saved.itemId)
    const reminder = items.createReminder({ actionId: 'reminder', itemId: saved.itemId, linkPurpose: 'independent', body: '去公园',
      dueAtUtc: new Date(Date.now() + 3600000).toISOString(), timezone: 'Asia/Shanghai' })
    expect(reminder.reminder.itemId).toBe(saved.itemId)
    expect(items.listReminders()).toHaveLength(1)
    db.prepare('INSERT INTO source_suppression(source_ref,created_at,deletion_epoch) VALUES(?,?,?)').run(source.messageId, new Date().toISOString(), 1)
    expect(currentCandidateContext(mode, tasks)).toBeNull()
    expect(tools.execute('notes_create', args, 'after-forget')).toMatchObject({ status: 'failed', errorCode: 'CANDIDATE_CONTEXT_STALE' })
    expect(items.list()).toHaveLength(1)
  } finally { tasks.close(); db.close() }
})
