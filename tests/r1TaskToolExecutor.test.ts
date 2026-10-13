import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1TaskToolExecutor } from '../electron/main/r1/taskToolExecutor'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
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
})
