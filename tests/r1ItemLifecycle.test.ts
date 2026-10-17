import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1Items } from '../electron/main/r1/items'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1TaskToolExecutor } from '../electron/main/r1/taskToolExecutor'
import { R1ConversationTools } from '../electron/main/r1/conversationTools'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
const assets = loadR1PromptAssets(resolve('r1-assets'))
function setup(temporary = false) {
 const db = openR1Database(':memory:'), conversations = new R1Conversations(db), items = new R1Items(db)
 const source = conversations.append({ sessionId: conversations.start(temporary), turnId: 'turn', role: 'user', body: '修改购物待办，然后完成并撤销完成', status: 'final' })
 const tasks = new R1TaskSupervisor(db, assets, () => 0)
 const scope = { source, temporary, timezone: 'Asia/Shanghai', persistenceConfirmed: false, assertCurrent() {} }
 const tools = new R1ConversationTools(db, assets, tasks, scope, [])
 const item = items.create({ actionId: 'seed', kind: 'todo', title: '购物', body: '买茶和牛奶' }).item
 return { db, items, source, tasks, scope, tools, item, close() { tasks.close(); db.close() } }
}
it('modifies the same Item, completes and undoes with only the dedicated undelivered reminder following the todo', () => {
 const s = setup()
 try {
  const dueAtUtc = new Date(Date.now() + 3600000).toISOString()
  const dedicated = s.items.createReminder({ actionId: 'dedicated', itemId: s.item.itemId, body: '购物', dueAtUtc, timezone: 'Asia/Shanghai', linkPurpose: 'todo_due' }).reminder
  const independent = s.items.createReminder({ actionId: 'independent', itemId: s.item.itemId, body: '单独提醒', dueAtUtc, timezone: 'Asia/Shanghai', linkPurpose: 'independent' }).reminder
  s.tools.execute('load_skill', { skillId: 'SK03' }, 'load')
  s.tools.execute('notes_list', { itemIds: [s.item.itemId] }, 'find')
  const changed = s.tools.execute('notes_update', { itemId: s.item.itemId, expectedVersion: 1, patch: { content: '买茶和燕麦奶' } }, 'update')
  expect(changed).toMatchObject({ status: 'succeeded', entityId: s.item.itemId, entityVersion: 2, data: { item: { title: '购物', content: '买茶和燕麦奶', type: 'todo' } } })
  const args = { itemId: s.item.itemId, expectedVersion: 2, completed: true }
  const completed = s.tools.execute('notes_complete', args, 'complete')
  expect(completed).toMatchObject({ status: 'succeeded', entityVersion: 3, data: { item: { completed: true }, reminderReceipts: [{ entityId: dedicated.reminderId, detail: 'cancelled_with_todo' }] } })
  expect(s.tools.execute('notes_complete', args, 'complete')).toEqual(completed)
  expect(s.items.listReminders().find(row => row.reminderId === independent.reminderId)?.status).toBe('scheduled')
  expect(s.tools.execute('notes_complete', { ...args, expectedVersion: 3, completed: false }, 'undo')).toMatchObject({ status: 'succeeded', entityVersion: 4, data: { item: { completed: false }, reminderReceipts: [{ detail: 'restored_after_undo' }] } })
  expect(s.items.listReminders().every(row => row.status === 'scheduled')).toBe(true)
  expect(s.items.list()).toHaveLength(1)
 } finally { s.close() }
})
it('rejects unobserved/foreign entity IDs, stale page versions and temporary writes without changing data', () => {
 const s = setup()
 try {
  s.tools.execute('load_skill', { skillId: 'SK03' }, 'load')
  const args = { itemId: s.item.itemId, expectedVersion: 1, patch: { title: '新标题' } }
  expect(s.tools.execute('notes_update', args, 'unseen')).toMatchObject({ errorCode: 'ITEM_NOT_OBSERVED' })
  s.tools.execute('notes_list', {}, 'find')
  s.items.update({ actionId: 'page', itemId: s.item.itemId, expectedVersion: 1, kind: 'todo', title: '页面新标题', body: '页面内容' })
  expect(s.tools.execute('notes_update', args, 'stale')).toMatchObject({ errorCode: 'VERSION_CONFLICT' })
  expect(s.items.toolView(s.item.itemId)).toMatchObject({ title: '页面新标题', content: '页面内容', version: 2 })
  const temporary = new R1ConversationTools(s.db, assets, s.tasks, { ...s.scope, temporary: true,
   source: { ...s.source, messageId: 'temporary-unpersisted' } }, [])
  temporary.execute('load_skill', { skillId: 'SK03' }, 'load')
  temporary.execute('notes_list', {}, 'find')
  expect(temporary.execute('notes_complete', { itemId: s.item.itemId, expectedVersion: 2, completed: true }, 'blocked')).toMatchObject({ errorCode: 'TEMPORARY_SAVE_CONFIRMATION_REQUIRED' })
  expect(s.items.toolView(s.item.itemId).completed).toBe(false)
 } finally { s.close() }
})
it('rolls back item and reminder mutations when the final tool output contract fails', () => {
 const s = setup()
 try {
  s.tools.execute('load_skill', { skillId: 'SK03' }, 'load'); s.tools.execute('notes_list', {}, 'find')
  const original = assets.validateToolOutput.bind(assets)
  const guard = vi.spyOn(assets, 'validateToolOutput').mockImplementation((alias, output) => {
   if (alias === 'notes_complete' && (output as { status?: string }).status === 'succeeded') throw new Error('MODEL_TOOL_OUTPUT_INVALID')
   original(alias, output)
  })
  try { expect(s.tools.execute('notes_complete', { itemId: s.item.itemId, expectedVersion: 1, completed: true }, 'complete')).toMatchObject({ status: 'failed' }) }
  finally { guard.mockRestore() }
  expect(s.items.toolView(s.item.itemId)).toMatchObject({ version: 1, completed: false })
 } finally { s.close() }
})
it('uses the same item lifecycle from a delegated task with real observation, receipts and replay', () => {
 const s = setup()
 try {
  const task = s.tasks.accept({ requestKey: 'task', sourceMessageId: s.source.messageId, timezone: 'Asia/Shanghai', goal: s.source.body,
   constraints: [], authorizedAliases: ['read_file', 'notes_list', 'notes_update', 'notes_complete'], complexity: 'complex' })
  const active = s.tasks.claimNext()!, executor = new R1TaskToolExecutor(s.tasks, assets, s.items)
  executor.execute(active.lease, 'read_file', { file_path: '/skills/capture-item/SKILL.md' }, 'load')
  executor.execute(active.lease, 'notes_list', { itemIds: [s.item.itemId] }, 'find')
  const args = { itemId: s.item.itemId, expectedVersion: 1, patch: { content: '任务修改的购物清单' } }
  const saved = executor.execute(active.lease, 'notes_update', args, 'update')
  expect(saved).toMatchObject({ status: 'succeeded', entityId: s.item.itemId, entityVersion: 2 })
  expect(executor.execute(active.lease, 'notes_update', args, 'update')).toEqual(saved)
  expect(executor.execute(active.lease, 'notes_complete', { itemId: s.item.itemId, expectedVersion: 2, completed: true }, 'done')).toMatchObject({ status: 'succeeded', entityVersion: 3 })
  expect(s.items.list()).toHaveLength(1)
  expect(s.tasks.get(task.taskId).status).toBe('running')
 } finally { s.close() }
})
