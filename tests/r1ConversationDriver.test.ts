import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1Items } from '../electron/main/r1/items'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1ConversationDriver } from '../electron/main/r1/conversationDriver'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import type { ArkResponse, createArkResponsesProvider } from '../electron/main/providers/arkResponsesProvider'
const assets = loadR1PromptAssets(resolve('r1-assets'))
type Request = Parameters<ReturnType<typeof createArkResponsesProvider>['request']>[0]
function fixture(finalCall = false, revokeFinal = false) {
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db), items = new R1Items(db)
  const tasks = new R1TaskSupervisor(db, assets, () => 0)
  const reminder = items.createReminder({ actionId: 'setup', body: '合成浇水提醒', linkPurpose: 'independent',
    timezone: 'Asia/Shanghai', dueAtUtc: new Date(Date.now() + 3600000).toISOString() }).reminder
  const source = conversations.append({ sessionId: conversations.start(), turnId: 'turn', role: 'user', body: '取消浇水提醒', status: 'final' })
  const planned = [ ['load_skill', { skillId: 'SK04' }], ['reminders_list', {}],
    ['cancel_task', { taskId: reminder.reminderId, expectedGoalVersion: 1 }],
    ['reminders_cancel', { reminderId: reminder.reminderId, expectedVersion: 1 }] ] as const
  let requests = 0, current = true
  const provider = { async request(input: Request): Promise<ArkResponse> {
    const index = requests++, prepared = input.boundary.finalize(input.messages)
    if (index === 4) {
      expect(prepared.tools).toEqual([])
      const receipts = input.rounds!.flatMap(round => round.results.map(value => value.output as { status: string; errorCode: string | null }))
      expect(receipts).toContainEqual(expect.objectContaining({ status: 'failed', errorCode: 'TASK_NOT_FOUND' }))
      expect(receipts.at(-1)?.status).toBe('succeeded')
      expect(items.listReminders()[0].status).toBe('cancelled')
      if (revokeFinal) current = false
      if (!finalCall) return { id: 'summary', text: '已取消浇水提醒，记录保留。', output: [], calls: [], usage: null }
    }
    const [name, args] = index < 4 ? planned[index] : ['reminders_cancel', { reminderId: reminder.reminderId, expectedVersion: 2 }]
    const call = { type: 'function_call' as const, call_id: `call-${index}`, name, arguments: JSON.stringify(args) }
    return { id: `response-${index}`, text: '', output: [call], calls: [call], usage: null }
  } }
  const persona = { assistantName: 'Seamo AI', userAddress: '', style: '', voiceId: '', version: 1 }
  const driver = new R1ConversationDriver(db, assets, tasks, provider, () => persona, [])
  const run = () => driver.reply({ scope: { source, timezone: 'Asia/Shanghai', temporary: false, persistenceConfirmed: false,
    assertCurrent() { if (!current) throw new Error('SESSION_CHANGED') } }, messages: [{ role: 'user', content: source.body }],
    context: { sessionId: source.sessionId, sessionGeneration: 1, turnId: source.turnId, currentTime: source.createdAt,
      timezone: 'Asia/Shanghai', temporary: false, contextVersion: 1, personaVersion: 1, deletionEpoch: 0,
      selectedEntity: null, availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: [], memories: [], activeTasks: [] } })
  return { run, items, requests: () => requests, close() { tasks.close(); db.close() } }
}
it('reports a committed fourth-decision action in one tools-free final turn without repeating writes', async () => {
  const s = fixture()
  try {
    expect(await s.run()).toMatchObject({ reply: '已取消浇水提醒，记录保留。' })
    expect(s.requests()).toBe(5)
    expect(s.items.listReminders()).toHaveLength(1)
    expect(s.items.listReminders()[0]).toMatchObject({ status: 'cancelled', scheduleVersion: 2 })
  } finally { s.close() }
})
it('cannot execute an extra tool proposed in the final summary slot', async () => {
  const s = fixture(true)
  try {
    await expect(s.run()).rejects.toThrow('CONVERSATION_DECISION_BUDGET_EXHAUSTED')
    expect(s.requests()).toBe(5)
    expect(s.items.listReminders()[0]).toMatchObject({ status: 'cancelled', scheduleVersion: 2 })
  } finally { s.close() }
})
it('discards a final summary after its conversation is invalidated without undoing the actual reminder', async () => {
  const s = fixture(false, true)
  try {
    await expect(s.run()).rejects.toThrow('SESSION_CHANGED')
    expect(s.items.listReminders()[0]).toMatchObject({ status: 'cancelled', scheduleVersion: 2 })
  } finally { s.close() }
})
