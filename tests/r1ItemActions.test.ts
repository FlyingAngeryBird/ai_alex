import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1Items } from '../electron/main/r1/items'
import { R1Artifacts } from '../electron/main/r1/artifacts'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1TaskToolExecutor } from '../electron/main/r1/taskToolExecutor'
import { R1TaskRunner } from '../electron/main/r1/taskRunner'
import { R1PersonaStore } from '../electron/main/r1/persona'
import { R1ItemActions, type ItemActionView } from '../electron/main/r1/itemActions'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'

const assets = loadR1PromptAssets(resolve('r1-assets'))
let directory = ''
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'seamo-item-action-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

function setup(options: { sessionCurrent?: () => boolean; beforeWrite?: () => void; isTaskCurrent?: (task: { taskId: string; runId: string; goalVersion: number }) => boolean } = {}) {
  const db = openR1Database(':memory:'), items = new R1Items(db), artifacts = new R1Artifacts(db)
  const notifications: (ItemActionView | null)[] = []
  let now = Date.parse('2026-10-17T12:00:00Z')
  let choices = 0
  let nextPath: string | null | undefined
  const actions = new R1ItemActions(db, items, artifacts, {
    notify: (_owner, view) => { notifications.push(view) },
    choose: async (_name, extension) => { choices++; options.beforeWrite?.(); return nextPath === undefined ? join(directory, `export.${extension}`) : nextPath },
    isSessionCurrent: options.sessionCurrent ?? (() => true),
    isTaskCurrent: options.isTaskCurrent ?? (() => true),
    now: () => now
  })
  const context = (ownerId = 1) => ({ ownerId, sessionId: 'session-1', temporary: false, assertCurrent() {} })
  return { db, items, artifacts, actions, notifications, context,
    choices: () => choices, setPath(value: string | null | undefined) { nextPath = value }, advance(ms: number) { now += ms },
    close() { db.close() } }
}

it('offers a frozen delete preview, keeps reminders by default and never commits before the trusted confirmation', async () => {
  const s = setup()
  try {
    const item = s.items.create({ actionId: 'seed', kind: 'todo', title: '购物', body: '茶' }).item
    const dueAtUtc = new Date(Date.now() + 3600_000).toISOString()
    s.items.createReminder({ actionId: 'rem', itemId: item.itemId, body: '购物', dueAtUtc, timezone: 'Asia/Shanghai', linkPurpose: 'todo_due' })
    const view = s.actions.offerDelete(s.context(), { itemId: item.itemId, expectedVersion: 1 })
    expect(view).toMatchObject({ action: 'confirm_item_delete', data: { item: { itemId: item.itemId, version: 1 } } })
    expect(view.data.reminders).toHaveLength(1)
    expect(s.items.list()).toHaveLength(1)
    expect(s.notifications.at(-1)?.ticket).toBe(view.ticket)

    await expect(s.actions.resolve(2, { ticket: view.ticket, decision: 'delete', reminderDisposition: 'keep' }))
      .rejects.toThrow('ITEM_ACTION_NOT_FOUND')
    const result = await s.actions.resolve(1, { ticket: view.ticket, decision: 'delete', reminderDisposition: 'keep' })
    expect(result).toMatchObject({ cancelled: false, itemId: item.itemId, deleted: true })
    expect(s.items.list()).toHaveLength(0)
    expect(s.items.listReminders()[0]).toMatchObject({ status: 'scheduled', itemId: null })
    // A repeated click replays the committed result and cannot delete twice.
    expect(await s.actions.resolve(1, { ticket: view.ticket, decision: 'delete', reminderDisposition: 'cancel' })).toEqual(result)
    expect(s.notifications.at(-1)).toBeNull()
  } finally { s.close() }
})

it('rejects a stale Item version or changed reminder snapshot instead of deleting newer data', async () => {
  const s = setup()
  try {
    const item = s.items.create({ actionId: 'seed', kind: 'note', title: '记录', body: '正文' }).item
    const first = s.actions.offerDelete(s.context(), { itemId: item.itemId, expectedVersion: 1 })
    s.items.update({ actionId: 'page', itemId: item.itemId, expectedVersion: 1, kind: 'note', title: '记录', body: '页面修改' })
    await expect(s.actions.resolve(1, { ticket: first.ticket, decision: 'delete', reminderDisposition: 'keep' })).rejects.toThrow('ITEM_ACTION_STALE')
    expect(s.items.list()).toHaveLength(1)
    const second = s.actions.offerDelete(s.context(), { itemId: item.itemId, expectedVersion: 2 })
    const dueAtUtc = new Date(Date.now() + 3600_000).toISOString()
    const reminder = s.items.createReminder({ actionId: 'rem', itemId: item.itemId, body: '提醒', dueAtUtc, timezone: 'Asia/Shanghai', linkPurpose: 'independent' }).reminder
    s.items.reschedule({ actionId: 'move', reminderId: reminder.reminderId, expectedScheduleVersion: 1, dueAtUtc: new Date(Date.now() + 7200_000).toISOString(), timezone: 'Asia/Shanghai' })
    await expect(s.actions.resolve(1, { ticket: second.ticket, decision: 'delete', reminderDisposition: 'keep' })).rejects.toThrow('ITEM_ACTION_STALE')
    expect(s.items.list()).toHaveLength(1)
  } finally { s.close() }
})

it('expires a pending confirmation without forcing an early decision and reports it explicitly', async () => {
  const s = setup()
  try {
    const item = s.items.create({ actionId: 'seed', kind: 'note', title: '记录', body: '正文' }).item
    const view = s.actions.offerDelete(s.context(), { itemId: item.itemId, expectedVersion: 1 })
    expect(Date.parse(view.expiresAt) - Date.parse('2026-10-17T12:00:00Z')).toBe(300_000)
    s.advance(300_001)
    await expect(s.actions.resolve(1, { ticket: view.ticket, decision: 'delete', reminderDisposition: 'keep' })).rejects.toThrow('ITEM_ACTION_EXPIRED')
    expect(s.items.list()).toHaveLength(1)
  } finally { s.close() }
})

it('writes an Item export only after the user confirms and replays the result without rewriting', async () => {
  const s = setup()
  try {
    const item = s.items.create({ actionId: 'seed', kind: 'note', title: '笔记', body: '导出内容' }).item
    const view = s.actions.offerExport(s.context(), { reason: 'model', kind: 'export', itemIds: [item.itemId],
      artifactId: null, artifactVersion: null, format: 'md' })
    expect(view.data.items).toEqual([{ itemId: item.itemId, title: '笔记', version: 1 }])
    const result = await s.actions.resolve(1, { ticket: view.ticket, decision: 'export' })
    expect(result).toMatchObject({ cancelled: false, format: 'md' })
    expect(readFileSync((result as { path: string }).path, 'utf8')).toContain('导出内容')
    const choices = s.choices()
    expect(await s.actions.resolve(1, { ticket: view.ticket, decision: 'export' })).toEqual(result)
    expect(s.choices()).toBe(choices)
    // Cancelling the native dialog produces no success receipt.
    s.setPath(null)
    const cancelled = s.actions.offerExport(s.context(), { reason: 'model', kind: 'export', itemIds: [item.itemId],
      artifactId: null, artifactVersion: null, format: 'txt' }, 'second')
    expect(await s.actions.resolve(1, { ticket: cancelled.ticket, decision: 'export' })).toEqual({ cancelled: true })
  } finally { s.close() }
})

it('rechecks versions while the save dialog is open and reports a written file whose receipt failed', async () => {
  const s = setup({ beforeWrite: () => undefined })
  try {
    const item = s.items.create({ actionId: 'seed', kind: 'note', title: '笔记', body: '正文' }).item
    const view = s.actions.offerExport(s.context(), { reason: 'model', kind: 'export', itemIds: [item.itemId],
      artifactId: null, artifactVersion: null, format: 'txt' })
    s.items.update({ actionId: 'page', itemId: item.itemId, expectedVersion: 1, kind: 'note', title: '笔记', body: '新正文' })
    await expect(s.actions.resolve(1, { ticket: view.ticket, decision: 'export' })).rejects.toThrow('VERSION_CONFLICT')
  } finally { s.close() }
})

it('exports an Artifact branch with the confirmed version and records a receipt', async () => {
  const s = setup()
  try {
    const artifact = s.artifacts.create({ sourceTurnId: 'turn', draft: { kind: 'text', title: '工作稿', content: '稿件内容',
      baseArtifactId: null, baseArtifactVersion: null, sourceRefs: [] } })
    const view = s.actions.offerExport(s.context(), { reason: 'model', kind: 'export', itemIds: [],
      artifactId: artifact.artifactId, artifactVersion: artifact.version, format: 'md' })
    expect(view.data.artifact).toMatchObject({ artifactId: artifact.artifactId, version: 1 })
    const result = await s.actions.resolve(1, { ticket: view.ticket, decision: 'export' })
    expect(result).toMatchObject({ cancelled: false, artifactId: artifact.artifactId, artifactVersion: 1 })
    const row = s.db.prepare('SELECT status FROM receipts WHERE action_id = ?').get(view.ticket) as { status: string }
    expect(row.status).toBe('succeeded')
  } finally { s.close() }
})

it('revokes pending confirmations on session change, cancel and task stop', async () => {
  let current = true
  const s = setup({ sessionCurrent: () => current })
  try {
    const item = s.items.create({ actionId: 'seed', kind: 'note', title: '记录', body: '正文' }).item
    const view = s.actions.offerDelete(s.context(), { itemId: item.itemId, expectedVersion: 1 })
    current = false
    await expect(s.actions.resolve(1, { ticket: view.ticket, decision: 'delete', reminderDisposition: 'keep' }))
      .rejects.toThrow('ITEM_ACTION_SESSION_CHANGED')
    current = true
    const second = s.actions.offerDelete(s.context(), { itemId: item.itemId, expectedVersion: 1 })
    s.actions.revokePending([second.ticket], 'TASK_STOPPED')
    await expect(s.actions.resolve(1, { ticket: second.ticket, decision: 'delete', reminderDisposition: 'keep' })).rejects.toThrow('TASK_STOPPED')
    expect(s.items.list()).toHaveLength(1)
    const third = s.actions.offerDelete(s.context(), { itemId: item.itemId, expectedVersion: 1 })
    expect(await s.actions.resolve(1, { ticket: third.ticket, decision: 'cancel' })).toEqual({ cancelled: true })
    expect(s.items.list()).toHaveLength(1)
  } finally { s.close() }
})

function taskSetup(ownerId = 7) {
  const db = openR1Database(':memory:'), items = new R1Items(db), artifacts = new R1Artifacts(db)
  const conversations = new R1Conversations(db)
  const tasks = new R1TaskSupervisor(db, assets, () => 0)
  const notifications: (ItemActionView | null)[] = []
  const actions = new R1ItemActions(db, items, artifacts, {
    notify: (_owner, view) => { notifications.push(view) },
    choose: async (_name, extension) => join(directory, `task-export.${extension}`),
    isSessionCurrent: () => true, isTaskCurrent: task => {
      try { return tasks.get(task.taskId).goalVersion === task.goalVersion } catch { return false }
    }
  })
  const executor = new R1TaskToolExecutor(tasks, assets, items, undefined, undefined, undefined, undefined, actions)
  tasks.bindPendingInvalidator((_taskId, actionIds, reason) => { actions.revokePending(actionIds, reason) })
  const source = conversations.append({ sessionId: conversations.start(), turnId: 'turn', role: 'user', body: '删除这条记录', status: 'final' })
  const task = tasks.accept({ requestKey: 'req', sourceMessageId: source.messageId, timezone: 'Asia/Shanghai',
    goal: '删除记录的合成委托', constraints: [], complexity: 'complex', ownerId,
    authorizedAliases: ['read_file', 'notes_list', 'notes_delete', 'notes_export'] })
  const active = tasks.claimNext()!
  executor.execute(active.lease, 'read_file', { file_path: '/skills/capture-item/SKILL.md' }, 'skill')
  return { db, items, artifacts, tasks, actions, executor, task, active, source, notifications,
    close() { tasks.close(); db.close() } }
}

const draft = (task: { goalVersion: number }, status: 'completed' | 'partial' | 'needs_input', unresolved: string[] = []) => ({
  status, goalVersion: task.goalVersion, replyBrief: '合成结果', sourceRefs: [], receiptActionIds: [],
  artifacts: [], candidates: [], unresolved })

it('keeps a Task ui_action out of completed results and links the confirmed receipt to the original run', async () => {
  const s = taskSetup()
  try {
    const item = s.items.create({ actionId: 'seed', kind: 'note', title: '记录', body: '正文' }).item
    s.executor.execute(s.active.lease, 'notes_list', { itemIds: [item.itemId] }, 'list')
    const output = await s.executor.executeAsync(s.active.lease, 'notes_delete',
      { itemId: item.itemId, expectedVersion: 1, reminderDisposition: 'keep', confirmedReminders: [] }, 'delete-call')
    expect(output).toMatchObject({ kind: 'ui_action', status: 'awaiting_user', action: 'confirm_item_delete' })
    expect(s.items.list()).toHaveLength(1)
    expect(() => s.tasks.publish(s.active.lease, draft(s.task, 'completed'), s.artifacts)).toThrow('TASK_COMPLETION_UI_PENDING')
    s.tasks.publish(s.active.lease, draft(s.task, 'needs_input', ['等待你在界面确认删除']), s.artifacts)
    expect(s.tasks.get(s.task.taskId).status).toBe('waiting_input')
    // The model cannot confirm on the user's behalf: the ticket belongs to the owner window.
    await expect(s.actions.resolve(8, { ticket: (output as { uiActionId: string }).uiActionId, decision: 'delete', reminderDisposition: 'keep' }))
      .rejects.toThrow('ITEM_ACTION_NOT_FOUND')
    await s.actions.resolve(7, { ticket: (output as { uiActionId: string }).uiActionId, decision: 'delete', reminderDisposition: 'keep' })
    expect(s.items.list()).toHaveLength(0)
    const linked = s.db.prepare('SELECT task_id, run_id, status FROM receipts WHERE action_id = ?')
      .get((output as { uiActionId: string }).uiActionId) as { task_id: string; run_id: string; status: string }
    expect(linked).toMatchObject({ task_id: s.task.taskId, run_id: s.active.lease.runId, status: 'succeeded' })
    // Resume adopts the confirmed receipt instead of replaying the deletion.
    s.tasks.resume(s.task.taskId, s.task.goalVersion)
    const next = s.tasks.claimNext()!
    expect(() => s.tasks.verifyRecovery(next.lease)).not.toThrow()
    expect(s.items.list()).toHaveLength(0)
  } finally { s.close() }
})

it('revokes an unconfirmed Task delete when the task is cancelled or its goal changes', async () => {
  const s = taskSetup()
  try {
    const item = s.items.create({ actionId: 'seed', kind: 'note', title: '记录', body: '正文' }).item
    s.executor.execute(s.active.lease, 'notes_list', { itemIds: [item.itemId] }, 'list')
    const output = await s.executor.executeAsync(s.active.lease, 'notes_delete',
      { itemId: item.itemId, expectedVersion: 1, reminderDisposition: 'keep', confirmedReminders: [] }, 'delete-call')
    s.tasks.cancel(s.task.taskId, s.task.goalVersion)
    await expect(s.actions.resolve(7, { ticket: (output as { uiActionId: string }).uiActionId, decision: 'delete', reminderDisposition: 'keep' }))
      .rejects.toThrow(/TASK_(STOPPED|CANCELLED)/)
    expect(s.items.list()).toHaveLength(1)
  } finally { s.close() }
})

it('prepares a Task export UI action, writes only after confirmation and adopts the receipt on resume', async () => {
  const s = taskSetup()
  try {
    const item = s.items.create({ actionId: 'seed', kind: 'note', title: '导出记录', body: '导出正文' }).item
    s.executor.execute(s.active.lease, 'notes_list', { itemIds: [item.itemId] }, 'list')
    const output = await s.executor.executeAsync(s.active.lease, 'notes_export',
      { itemIds: [item.itemId], artifactId: null, artifactVersion: null, format: 'txt' }, 'export-call')
    expect(output).toMatchObject({ kind: 'ui_action', action: 'export', status: 'awaiting_user' })
    expect(s.notifications.at(-1)?.data.items?.[0]).toMatchObject({ itemId: item.itemId, version: 1 })
    // No file exists before the user confirms, and another window cannot confirm.
    expect(() => readFileSync(join(directory, 'task-export.txt'))).toThrow()
    await expect(s.actions.resolve(8, { ticket: (output as { uiActionId: string }).uiActionId, decision: 'export' }))
      .rejects.toThrow('ITEM_ACTION_NOT_FOUND')
    const result = await s.actions.resolve(7, { ticket: (output as { uiActionId: string }).uiActionId, decision: 'export' })
    expect(result).toMatchObject({ cancelled: false, format: 'txt' })
    expect(readFileSync((result as { path: string }).path, 'utf8')).toContain('导出正文')
    const linked = s.db.prepare('SELECT task_id, run_id FROM receipts WHERE action_id = ?')
      .get((output as { uiActionId: string }).uiActionId) as { task_id: string; run_id: string }
    expect(linked).toMatchObject({ task_id: s.task.taskId, run_id: s.active.lease.runId })
    s.tasks.publish(s.active.lease, draft(s.task, 'needs_input', ['等待你在界面确认导出']), s.artifacts)
    s.tasks.resume(s.task.taskId, s.task.goalVersion)
    const next = s.tasks.claimNext()!
    expect(() => s.tasks.verifyRecovery(next.lease)).not.toThrow()
    expect(s.tasks.beginDecision(next.lease).validReceiptActionIds).toContain((output as { uiActionId: string }).uiActionId)
  } finally { s.close() }
})

it('keeps the kept-reminder IDs from the real delete receipts instead of the preview', async () => {
  const s = setup()
  try {
    const item = s.items.create({ actionId: 'seed', kind: 'todo', title: '购物', body: '茶' }).item
    const dueAtUtc = new Date(Date.now() + 3600_000).toISOString()
    const reminder = s.items.createReminder({ actionId: 'rem', itemId: item.itemId, body: '购物', dueAtUtc,
      timezone: 'Asia/Shanghai', linkPurpose: 'todo_due' }).reminder
    const keep = s.actions.offerDelete(s.context(), { itemId: item.itemId, expectedVersion: 1 })
    expect(await s.actions.resolve(1, { ticket: keep.ticket, decision: 'delete', reminderDisposition: 'keep' }))
      .toMatchObject({ remainingReminderIds: [reminder.reminderId] })
    const second = s.items.create({ actionId: 'seed-2', kind: 'todo', title: '购物2', body: '茶' }).item
    const reminder2 = s.items.createReminder({ actionId: 'rem-2', itemId: second.itemId, body: '购物2', dueAtUtc,
      timezone: 'Asia/Shanghai', linkPurpose: 'todo_due' }).reminder
    const cancel = s.actions.offerDelete(s.context(), { itemId: second.itemId, expectedVersion: 1 })
    expect(await s.actions.resolve(1, { ticket: cancel.ticket, decision: 'delete', reminderDisposition: 'cancel' }))
      .toMatchObject({ remainingReminderIds: [] })
    expect(s.items.listReminders().find(row => row.reminderId === reminder2.reminderId)).toMatchObject({ status: 'cancelled' })
  } finally { s.close() }
})

it('shares one export commit across concurrent confirmations', async () => {
  const s = setup()
  try {
    const item = s.items.create({ actionId: 'seed', kind: 'note', title: '笔记', body: '并发导出' }).item
    const view = s.actions.offerExport(s.context(), { reason: 'model', kind: 'export', itemIds: [item.itemId],
      artifactId: null, artifactVersion: null, format: 'txt' })
    const [first, second] = await Promise.all([
      s.actions.resolve(1, { ticket: view.ticket, decision: 'export' }),
      s.actions.resolve(1, { ticket: view.ticket, decision: 'export' })
    ])
    expect(first).toEqual(second)
    expect(s.choices()).toBe(1)
    expect(readFileSync((first as { path: string }).path, 'utf8')).toContain('并发导出')
  } finally { s.close() }
})

it('refuses to write when the ticket is revoked while the save dialog is open', async () => {
  let ticket = ''
  const s = setup({ beforeWrite: () => { s.actions.revokePending([ticket], 'TASK_CANCELLED') } })
  try {
    const item = s.items.create({ actionId: 'seed', kind: 'note', title: '笔记', body: '撤销导出' }).item
    const view = s.actions.offerExport(s.context(), { reason: 'model', kind: 'export', itemIds: [item.itemId],
      artifactId: null, artifactVersion: null, format: 'txt' })
    ticket = view.ticket
    s.setPath(join(directory, 'revoked.txt'))
    await expect(s.actions.resolve(1, { ticket: view.ticket, decision: 'export' }))
      .rejects.toThrow('ITEM_ACTION_REVOKED')
    expect(() => readFileSync(join(directory, 'revoked.txt'))).toThrow()
  } finally { s.close() }
})

it('refuses to write when the session or Task binding changes while the dialog is open', async () => {
  let current = true
  const s = setup({ sessionCurrent: () => current, beforeWrite: () => { current = false } })
  try {
    const item = s.items.create({ actionId: 'seed', kind: 'note', title: '笔记', body: '会话变化' }).item
    const view = s.actions.offerExport(s.context(), { reason: 'model', kind: 'export', itemIds: [item.itemId],
      artifactId: null, artifactVersion: null, format: 'txt' })
    s.setPath(join(directory, 'session-changed.txt'))
    await expect(s.actions.resolve(1, { ticket: view.ticket, decision: 'export' }))
      .rejects.toThrow('ITEM_ACTION_SESSION_CHANGED')
    expect(() => readFileSync(join(directory, 'session-changed.txt'))).toThrow()
  } finally { s.close() }
  let taskCurrent = true
  const taskBound = setup({ isTaskCurrent: () => taskCurrent, beforeWrite: () => { taskCurrent = false } })
  try {
    const item = taskBound.items.create({ actionId: 'seed', kind: 'note', title: '笔记', body: '任务变化' }).item
    const context = { ...taskBound.context(), task: { taskId: 'task-1', runId: 'run-1', goalVersion: 1 } }
    const view = taskBound.actions.offerExport(context, { reason: 'model', kind: 'export', itemIds: [item.itemId],
      artifactId: null, artifactVersion: null, format: 'txt' })
    taskBound.setPath(join(directory, 'task-changed.txt'))
    await expect(taskBound.actions.resolve(1, { ticket: view.ticket, decision: 'export' }))
      .rejects.toThrow('ITEM_ACTION_TASK_STALE')
    expect(() => readFileSync(join(directory, 'task-changed.txt'))).toThrow()
  } finally { taskBound.close() }
})

it('links an Artifact export receipt to the original task/run with the ticket identity', async () => {
  const db = openR1Database(':memory:'), items = new R1Items(db), artifacts = new R1Artifacts(db)
  const conversations = new R1Conversations(db)
  const tasks = new R1TaskSupervisor(db, assets, () => 0)
  const actions = new R1ItemActions(db, items, artifacts, {
    notify: () => {}, choose: async (_name, extension) => join(directory, `artifact-task.${extension}`),
    isSessionCurrent: () => true,
    isTaskCurrent: task => { try { return tasks.get(task.taskId).goalVersion === task.goalVersion } catch { return false } }
  })
  try {
    const source = conversations.append({ sessionId: conversations.start(), turnId: 'turn', role: 'user',
      body: '导出工作稿', status: 'final' })
    const task = tasks.accept({ requestKey: 'req-artifact', sourceMessageId: source.messageId, timezone: 'Asia/Shanghai',
      goal: '导出合成工作稿', constraints: [], complexity: 'complex', ownerId: 7, authorizedAliases: ['read_file'] })
    const lease = tasks.claimNext()!.lease
    const artifact = artifacts.create({ sourceTurnId: source.turnId, draft: { kind: 'text', title: '工作稿', content: '稿件正文',
      baseArtifactId: null, baseArtifactVersion: null, sourceRefs: [] } })
    const view = actions.offerExport({ ownerId: 7, sessionId: source.sessionId, temporary: false,
      assertCurrent() { tasks.assertLease(lease) },
      task: { taskId: task.taskId, runId: lease.runId, goalVersion: task.goalVersion } },
      { reason: 'model', kind: 'export', itemIds: [], artifactId: artifact.artifactId,
        artifactVersion: artifact.version, format: 'txt' })
    const result = await actions.resolve(7, { ticket: view.ticket, decision: 'export' })
    expect(result).toMatchObject({ cancelled: false, artifactId: artifact.artifactId })
    const row = db.prepare('SELECT task_id, run_id, actual_result_json FROM receipts WHERE action_id = ?')
      .get(view.ticket) as { task_id: string; run_id: string; actual_result_json: string }
    expect(row).toMatchObject({ task_id: task.taskId, run_id: lease.runId })
    expect(JSON.parse(row.actual_result_json)).toMatchObject({ kind: 'receipt', actionId: view.ticket,
      tool: 'notes.export', runId: lease.runId })
  } finally { tasks.close(); db.close() }
})

it('stops a Task immediately when a ui_action is issued and adopts the confirmed receipt without replaying it', async () => {
  const db = openR1Database(':memory:'), items = new R1Items(db), artifacts = new R1Artifacts(db)
  const conversations = new R1Conversations(db)
  const tasks = new R1TaskSupervisor(db, assets, () => 0)
  const actions = new R1ItemActions(db, items, artifacts, {
    notify: () => {}, choose: async (_name, extension) => join(directory, `runner.${extension}`),
    isSessionCurrent: () => true,
    isTaskCurrent: task => { try { return tasks.get(task.taskId).goalVersion === task.goalVersion } catch { return false } },
    onTaskReceipt: taskId => { tasks.refreshExternalReceipts(taskId) }
  })
  const executor = new R1TaskToolExecutor(tasks, assets, items, undefined, undefined, undefined, undefined, actions)
  const item = items.create({ actionId: 'seed', kind: 'note', title: '记录', body: '正文' }).item
  const source = conversations.append({ sessionId: conversations.start(), turnId: 'turn', role: 'user',
    body: '把这条记录删掉', status: 'final' })
  const task = tasks.accept({ requestKey: 'req', sourceMessageId: source.messageId, timezone: 'Asia/Shanghai',
    goal: '删除合成记录', constraints: [], complexity: 'complex', ownerId: 7,
    authorizedAliases: ['read_file', 'notes_list', 'notes_delete'] })
  let requests = 0
  const provider = { async request() {
    requests++
    if (requests === 1) {
      const call = { type: 'function_call', id: 'c1', call_id: 'c1', name: 'read_file',
        arguments: JSON.stringify({ file_path: '/skills/capture-item/SKILL.md' }) }
      return { id: 'r1', output: [call], calls: [call], text: '', usage: null }
    }
    if (requests === 2) {
      const call = { type: 'function_call', id: 'c2', call_id: 'c2', name: 'notes_list',
        arguments: JSON.stringify({ itemIds: [item.itemId] }) }
      return { id: 'r2', output: [call], calls: [call], text: '', usage: null }
    }
    if (requests === 3) {
      const call = { type: 'function_call', id: 'c3', call_id: 'c3', name: 'notes_delete',
        arguments: JSON.stringify({ itemId: item.itemId, expectedVersion: 1, reminderDisposition: 'keep', confirmedReminders: [] }) }
      return { id: 'r3', output: [call], calls: [call], text: '', usage: null }
    }
    throw new Error('RUNNER_CONTINUED_AFTER_UI_ACTION')
  } } as unknown as ReturnType<typeof import('../electron/main/providers/arkResponsesProvider').createArkResponsesProvider>
  const runner = new R1TaskRunner(tasks, assets, executor, artifacts, provider, () => new R1PersonaStore(db).get())
  try {
    runner.start()
    await runner.idle()
    expect(requests).toBe(3)
    const waiting = tasks.get(task.taskId)
    expect(waiting.status).toBe('waiting_input')
    expect(waiting.result).toMatchObject({ completionStatus: 'needs_input', unresolved: ['等待界面确认'] })
    const ticket = tasks.pendingUiActions(task.taskId)[0].actionId
    expect(items.list()).toHaveLength(1)
    await actions.resolve(7, { ticket, decision: 'delete', reminderDisposition: 'keep' })
    expect(items.list()).toHaveLength(0)
    expect(tasks.get(task.taskId).status).toBe('waiting_input')
    expect(tasks.get(task.taskId).progressBrief).toContain('界面确认已完成')
    tasks.resume(task.taskId, task.goalVersion)
    const next = tasks.claimNext()!
    expect(() => tasks.verifyRecovery(next.lease)).not.toThrow()
    expect(items.list()).toHaveLength(0)
  } finally { tasks.close(); await runner.close(); db.close() }
})
