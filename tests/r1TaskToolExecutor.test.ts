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
