import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1Items } from '../electron/main/r1/items'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1ConversationTools } from '../electron/main/r1/conversationTools'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import type { ItemActionView } from '../electron/main/r1/itemActions'

const assets = loadR1PromptAssets(resolve('r1-assets'))
function setup(requestItemAction?: (input: Record<string, unknown>) => ItemActionView) {
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db), items = new R1Items(db)
  const source = conversations.append({ sessionId: conversations.start(), turnId: 'turn', role: 'user', body: '删除这条记录并导出一份', status: 'final' })
  const tasks = new R1TaskSupervisor(db, assets, () => 0)
  const scope = { source, temporary: false, timezone: 'Asia/Shanghai', persistenceConfirmed: false, ownerId: 3,
    assertCurrent() {}, ...(requestItemAction ? { requestItemAction } : {}) }
  const tools = new R1ConversationTools(db, assets, tasks, scope, [])
  const item = items.create({ actionId: 'seed', kind: 'note', title: '记录', body: '正文' }).item
  return { db, items, tools, item, close() { tasks.close(); db.close() } }
}
const view = (kind: 'delete' | 'export'): ItemActionView => ({ ticket: `ticket-${kind}`,
  action: kind === 'delete' ? 'confirm_item_delete' : 'export',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  data: kind === 'delete' ? { item: { itemId: 'item', title: '记录', version: 1, type: 'note' } } : { format: 'md' } })

it('routes delete and export to the trusted renderer without committing or confirming on the model side', () => {
  const requestItemAction = vi.fn((input: Record<string, unknown>) => view(input.kind as 'delete' | 'export'))
  const s = setup(requestItemAction)
  try {
    s.tools.execute('load_skill', { skillId: 'SK03' }, 'load')
    s.tools.execute('notes_list', { itemIds: [s.item.itemId] }, 'find')
    const receiptsBefore = (s.db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n
    const deleted = s.tools.execute('notes_delete', { itemId: s.item.itemId, expectedVersion: 1,
      reminderDisposition: 'keep', confirmedReminders: [] }, 'delete-call')
    expect(deleted).toMatchObject({ kind: 'ui_action', uiActionId: 'ticket-delete', status: 'awaiting_user',
      action: 'confirm_item_delete' })
    expect(requestItemAction).toHaveBeenCalledWith({ kind: 'delete', itemId: s.item.itemId, expectedVersion: 1 })
    expect(s.items.list()).toHaveLength(1)
    expect((s.db.prepare('SELECT COUNT(*) AS n FROM receipts').get() as { n: number }).n).toBe(receiptsBefore)
    // The model cannot choose reminder disposition: only the UI confirmation can.
    expect(requestItemAction.mock.calls[0][0]).not.toHaveProperty('reminderDisposition')
    const exported = s.tools.execute('notes_export', { itemIds: [s.item.itemId], artifactId: null,
      artifactVersion: null, format: 'md' }, 'export-call')
    expect(exported).toMatchObject({ kind: 'ui_action', uiActionId: 'ticket-export', action: 'export' })
    expect(requestItemAction).toHaveBeenLastCalledWith({ kind: 'export', itemIds: [s.item.itemId],
      artifactId: null, artifactVersion: null, format: 'md' })
  } finally { s.close() }
})

it('rejects delete/export when no trusted confirmation channel or observed version exists', () => {
  const s = setup()
  try {
    s.tools.execute('load_skill', { skillId: 'SK03' }, 'load')
    s.tools.execute('notes_list', {}, 'find')
    expect(s.tools.execute('notes_delete', { itemId: s.item.itemId, expectedVersion: 1,
      reminderDisposition: 'keep', confirmedReminders: [] }, 'no-channel')).toMatchObject({ errorCode: 'ITEM_ACTION_UNAVAILABLE' })
    expect(s.items.list()).toHaveLength(1)
  } finally { s.close() }
  const withChannel = setup(() => view('delete'))
  try {
    withChannel.tools.execute('load_skill', { skillId: 'SK03' }, 'load')
    expect(withChannel.tools.execute('notes_delete', { itemId: withChannel.item.itemId, expectedVersion: 1,
      reminderDisposition: 'keep', confirmedReminders: [] }, 'unobserved')).toMatchObject({ errorCode: 'ITEM_NOT_OBSERVED' })
  } finally { withChannel.close() }
})
