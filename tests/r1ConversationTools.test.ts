import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1ConversationTools } from '../electron/main/r1/conversationTools'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { R1Items } from '../electron/main/r1/items'
const assets = loadR1PromptAssets(resolve('r1-assets'))
function setup(temporary = false) {
  const db = openR1Database(':memory:'); const conversations = new R1Conversations(db)
  const source = conversations.append({ sessionId: conversations.start(temporary), turnId: 'turn', role: 'user',
    body: '整理一份讨论稿', status: 'final' })
  let epoch = 0; let current = true
  const tasks = new R1TaskSupervisor(db, assets, () => epoch, { temporarySource: id => temporary && id === source.messageId
    ? { ...source, temporary: true, timezone: 'Asia/Shanghai' } : undefined })
  const scope = { source, timezone: 'Asia/Shanghai', temporary, persistenceConfirmed: false,
    assertCurrent: () => { if (!current) throw new Error('SESSION_CHANGED') } }
  const tools = new R1ConversationTools(db, assets, tasks, scope, ['read_file', 'write_todos', 'notes_create'])
  return { db, tasks, source, scope, tools, stale: () => { current = false }, forget: () => { epoch++ } }
}
describe('registered main-conversation tool execution', () => {
  it('keeps the sandboxed Skill reader available for a domain-only web delegation', () => {
    const s = setup()
    try {
      const tools = new R1ConversationTools(s.db, assets, s.tasks, s.scope, ['read_file', 'web_search', 'web_read_page'])
      expect(tools.execute('start_task', { goal: '查询官方来源', constraints: [], sourceRefs: [],
        delegation: { toolAliases: ['web_search', 'web_read_page'], requiredActions: [] } }, 'web')).toMatchObject({ status: 'accepted' })
      const active = s.tasks.claimNext()!
      expect(s.tasks.authorizedAliases(active.lease)).toEqual(['read_file', 'web_search', 'web_read_page'])
    } finally { s.tasks.close(); s.db.close() }
  })
  it('refuses to return a legacy completed web conclusion with no actual web receipts', () => {
    const s = setup()
    let reopened: R1TaskSupervisor | undefined
    try {
      const task = s.tasks.accept({ requestKey: 'legacy', sourceMessageId: s.source.messageId, timezone: 'Asia/Shanghai',
        goal: '联网查证', constraints: [], authorizedAliases: ['web_search', 'web_read_page'], complexity: 'complex' })
      s.tasks.claimNext()
      s.tasks.close()
      const row = s.db.prepare('SELECT checkpoint_json FROM agent_tasks WHERE task_id=?').get(task.taskId) as { checkpoint_json: string }
      const checkpoint = JSON.parse(row.checkpoint_json)
      checkpoint.result = { resultId: 'legacy-result', goalVersion: 1, completionStatus: 'completed', replyBrief: '未经查证的结论',
        sourceRefs: [s.source.messageId], artifacts: [], unresolved: [], candidateRefs: [], entityReceipts: [] }
      s.db.prepare("UPDATE agent_tasks SET status='succeeded',checkpoint_json=? WHERE task_id=?").run(JSON.stringify(checkpoint), task.taskId)
      reopened = new R1TaskSupervisor(s.db, assets, () => 0)
      const tools = new R1ConversationTools(s.db, assets, reopened, s.scope, ['read_file', 'web_search', 'web_read_page'])
      expect(tools.execute('get_task', { taskId: task.taskId }, 'get-legacy'))
        .toMatchObject({ status: 'failed', errorCode: 'TASK_COMPLETION_WEB_EVIDENCE_MISSING' })
    } finally { reopened?.close(); s.tasks.close(); s.db.close() }
  })
  it('returns real accepted idempotently with program source binding and rejects invented/unsupported grants', () => {
    const s = setup()
    try {
      const args = { goal: '整理讨论稿', constraints: [], sourceRefs: [s.source.turnId],
        delegation: { toolAliases: ['read_file', 'write_todos'], requiredActions: [] } }
      const first = s.tools.execute('start_task', args, 'start')
      expect(first).toMatchObject({ kind: 'task_control', status: 'accepted', goalVersion: 1 })
      expect(s.tools.execute('start_task', args, 'start')).toEqual(first)
      expect(s.tasks.list()).toHaveLength(1)
      const row = s.db.prepare('SELECT checkpoint_json FROM agent_tasks').get() as { checkpoint_json: string }
      expect(JSON.parse(row.checkpoint_json).source.messageId).toBe(s.source.messageId)
      expect(s.tools.execute('start_task', { ...args, sourceRefs: ['made-up'] }, 'wrong-source'))
        .toMatchObject({ status: 'failed', errorCode: 'CONVERSATION_SOURCE_NOT_AVAILABLE' })
      expect(s.tools.execute('start_task', { ...args, delegation: { toolAliases: ['web_search'], requiredActions: [] } }, 'missing-provider'))
        .toMatchObject({ status: 'failed', errorCode: 'TASK_TOOL_IMPLEMENTATION_UNAVAILABLE' })
      expect(() => s.tools.execute('start_task', { ...args, delegation: { toolAliases: ['start_task'], requiredActions: [] } }, 'recursive'))
        .toThrow('MODEL_TOOL_INPUT_INVALID')
      expect(s.tasks.list()).toHaveLength(1)
    } finally { s.tasks.close(); s.db.close() }
  })
  it('loads a real Skill before direct note creation, preserves format and replays the same receipt once', () => {
    const s = setup()
    try {
      const args = { type: 'note', title: '原文', content: '  一段正文\n', mode: 'original', sourceRefs: [] }
      expect(() => s.tools.execute('notes_create', args, 'note')).toThrow('MODEL_TOOL_NOT_EXPOSED')
      expect(s.tools.execute('load_skill', { skillId: 'SK03' }, 'load')).toMatchObject({ status: 'succeeded', data: { skillId: 'SK03' } })
      const saved = s.tools.execute('notes_create', args, 'note')
      expect(saved).toMatchObject({ status: 'succeeded', data: { item: { content: args.content, sourceRefs: [s.source.messageId] } } })
      expect(s.tools.execute('notes_create', args, 'note')).toEqual(saved)
      expect(new R1Items(s.db).list()).toHaveLength(1)
      expect(s.tasks.list()).toHaveLength(0)
      s.stale()
      expect(() => s.tools.execute('notes_create', args, 'late')).toThrow('SESSION_CHANGED')
      expect(new R1Items(s.db).list()).toHaveLength(1)
    } finally { s.tasks.close(); s.db.close() }
  })
  it('controls only the current mode, validates removal/version and narrows the new delegated scope', () => {
    const s = setup()
    try {
      const accepted = s.tools.execute('start_task', { goal: '整理并保存', constraints: ['长一点'], sourceRefs: [],
        delegation: { toolAliases: ['read_file', 'write_todos', 'notes_create'], requiredActions: [{ alias: 'notes_create', minimumCount: 1 }] } }, 'start')
      const id = accepted.taskId as string
      expect(s.tools.execute('get_task', { taskId: id }, 'get')).toMatchObject({ status: 'succeeded', data: { task: { goal: '整理并保存' } } })
      expect(s.tools.execute('steer_task', { taskId: id, expectedGoalVersion: 1, sourceRefs: [],
        patch: { goal: '仅整理', addConstraints: ['简短'], removeConstraints: ['不存在'] } }, 'bad-patch'))
        .toMatchObject({ status: 'failed', errorCode: 'TASK_CONSTRAINT_NOT_FOUND' })
      expect(s.tools.execute('steer_task', { taskId: id, expectedGoalVersion: 1, sourceRefs: [],
        patch: { goal: '仅整理', addConstraints: ['简短'], removeConstraints: ['长一点'] } }, 'steer'))
        .toMatchObject({ kind: 'task_control', status: 'updated', goalVersion: 2 })
      const active = s.tasks.claimNext()!
      expect(s.tasks.authorizedAliases(active.lease)).toEqual(['read_file', 'write_todos'])
      expect(s.tools.execute('pause_task', { taskId: id, expectedGoalVersion: 1 }, 'bad-version'))
        .toMatchObject({ status: 'failed', errorCode: 'VERSION_CONFLICT' })
      expect(s.tools.execute('pause_task', { taskId: id, expectedGoalVersion: 2 }, 'pause'))
        .toMatchObject({ status: 'pause_requested' })
      s.tasks.settlePause(active.lease)
      expect(s.tools.execute('cancel_task', { taskId: id, expectedGoalVersion: 2 }, 'cancel')).toMatchObject({ status: 'cancelled' })
    } finally { s.tasks.close(); s.db.close() }
  })
  it('blocks temporary persistence, never exposes ordinary tasks to temporary conversation, and redacts forgotten context', () => {
    const s = setup(true)
    try {
      s.tools.execute('load_skill', { skillId: 'SK03' }, 'load')
      expect(s.tools.execute('notes_create', { type: 'note', title: '正文', content: '临时内容', mode: 'organized', sourceRefs: [] }, 'note'))
        .toMatchObject({ status: 'failed', errorCode: 'TEMPORARY_SAVE_CONFIRMATION_REQUIRED' })
      expect(s.tools.execute('start_task', { goal: '保存', constraints: [], sourceRefs: [],
        delegation: { toolAliases: ['notes_create'], requiredActions: [] } }, 'persistent-task'))
        .toMatchObject({ status: 'failed', errorCode: 'TEMPORARY_SAVE_CONFIRMATION_REQUIRED' })
      expect(s.tools.execute('get_task', { taskId: 'ordinary-task' }, 'foreign')).toMatchObject({ status: 'failed', errorCode: 'TASK_NOT_FOUND' })
      const accepted = s.tools.execute('start_task', { goal: '旧偏好仅用于本任务', constraints: ['旧条件'], sourceRefs: [] }, 'start')
      s.forget(); s.tasks.invalidateContext()
      const view = s.tools.execute('get_task', { taskId: accepted.taskId }, 'after-forget')
      expect(JSON.stringify(view)).not.toContain('旧偏好')
      expect(JSON.stringify(view)).not.toContain('旧条件')
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get()).toMatchObject({ n: 0 })
      expect(new R1Items(s.db).list()).toEqual([])
    } finally { s.tasks.close(); s.db.close() }
  })
})

it('recalls only real valid memories through the registered tool and excludes forgotten and temporary context', async () => {
  const { R1MemoryStore } = await import('../electron/main/r1/memory')
  const s = setup()
  try {
    const store = new R1MemoryStore(s.db)
    const saved = store.addManual({ content: '喜欢无糖茶', category: 'preference' })
    const recall = s.tools.execute('memory_recall', { query: '无糖茶', category: 'preference' }, 'recall')
    expect(recall).toMatchObject({ status: 'succeeded', data: { matchStatus: 'matched', memories: [{ memoryId: saved.memoryId, content: saved.content, version: 1 }] } })
    store.forget(saved.memoryId, saved.version)
    expect(s.tools.execute('memory_recall', { query: '无糖茶' }, 'after-forget')).toMatchObject({ status: 'succeeded', data: { matchStatus: 'no_match', memories: [] } })
  } finally { s.tasks.close(); s.db.close() }
  const temp = setup(true)
  try { expect(() => temp.tools.execute('memory_recall', { query: '无糖茶' }, 'temporary')).toThrow('MODEL_TOOL_NOT_EXPOSED') }
  finally { temp.tasks.close(); temp.db.close() }
})
