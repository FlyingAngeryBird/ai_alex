// Real Ark, registered M01 boundary and actual domain writes; synthetic turns in isolated SQLite only.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1Items } from '../dist-electron/main/r1/items.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1ConversationDriver } from '../dist-electron/main/r1/conversationDriver.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
const endpoint = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
assert.equal(endpoint.origin, 'https://ark.cn-beijing.volces.com', 'OFFICIAL_ENDPOINT_REQUIRED')
const db = openR1Database(':memory:'), assets = loadR1PromptAssets(resolve('r1-assets'))
const conversations = new R1Conversations(db), items = new R1Items(db), sessionId = conversations.start()
const tasks = new R1TaskSupervisor(db, assets, () => 0), calls = []
const provider = createArkResponsesProvider({ timeoutMs: 30000, fetch: async (url, init) => {
  const response = await fetch(url, init), body = await response.clone().json()
  calls.push(...(body.output ?? []).filter(item => item.type === 'function_call').map(item => item.name))
  if (process.env.SEAMO_CHECK_DIAGNOSTIC === '1') {
    const request = JSON.parse(String(init.body))
    console.log(JSON.stringify({ syntheticTrace: { calls: (body.output ?? []).filter(item => item.type === 'function_call'),
      toolResults: (request.input ?? []).filter(item => item.type === 'function_call_output') } }))
  }
  return response
} })
const persona = { assistantName: 'Seamo AI', userAddress: '', style: '自然、简洁', voiceId: '', version: 1 }
const driver = new R1ConversationDriver(db, assets, tasks, provider, () => persona, [])
const tomorrow = () => {
  const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).split('-').map(Number)
  return new Date(Date.UTC(localDay[0], localDay[1] - 1, localDay[2] + 1)).toISOString().slice(0, 10)
}
let reminderId = null
async function turn(phase, text, verify) {
  const start = performance.now(), callStart = calls.length
  const source = conversations.append({ sessionId, turnId: randomUUID(), role: 'user', body: text, status: 'final' })
  const turns = conversations.modelTurns(sessionId)
  const reply = await driver.reply({ scope: { source, sourceMessages: conversations.messages(sessionId), timezone: 'Asia/Shanghai',
    temporary: false, persistenceConfirmed: false, assertCurrent() {} },
    context: { sessionId, sessionGeneration: 1, turnId: source.turnId, currentTime: source.createdAt,
      timezone: 'Asia/Shanghai', temporary: false, contextVersion: 1, personaVersion: 1, deletionEpoch: 0,
      selectedEntity: null, availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: turns, memories: [], activeTasks: [] },
    messages: turns.filter(value => value.text.trim()).map(value => ({ role: value.role, content: value.text })) })
  conversations.append({ sessionId, turnId: source.turnId, role: 'assistant', body: reply.reply, status: 'generated' })
  try { verify(items.listReminders(), reply.reply) } catch (error) {
    console.log(JSON.stringify({ phase, status: 'failed', reply: reply.reply, calls: calls.slice(callStart),
      assertion: error.message, reminders: items.listReminders() })); throw error
  }
  assert.equal(tasks.list().length, 0, 'UNEXPECTED_BACKGROUND_TASK')
  console.log(JSON.stringify({ phase, status: 'passed', reply: reply.reply, calls: calls.slice(callStart),
    reminders: items.listReminders().map(({ body, dueAtUtc, timezone, scheduleVersion, status }) => ({ body, dueAtUtc, timezone, scheduleVersion, status })),
    elapsedMs: Math.round(performance.now() - start), database: 'isolated-in-memory', microphoneOpened: false,
    notificationsStarted: false, audioPlayed: false, profileBusinessWrites: false, assetReleaseId: assets.releaseId }))
}
try {
  if (process.env.SEAMO_CHECK_FROM !== 'follow_up') {
  await turn('create', '明天上午九点提醒我：给合成验收的植物浇水。仅创建一次提醒，不要保存便签或待办。', rows => {
    assert.equal(rows.length, 1, 'CREATE_COUNT'); reminderId = rows[0].reminderId
    assert.equal(rows[0].dueAtUtc, new Date(`${tomorrow()}T09:00:00+08:00`).toISOString(), 'CREATE_TIME')
    assert.equal(rows[0].timezone, 'Asia/Shanghai'); assert.equal(rows[0].scheduleVersion, 1)
  })
  await turn('reschedule', '把刚才给植物浇水的提醒改到明天上午十点，不要另建一条。', rows => {
    assert.equal(rows.length, 1, 'RESCHEDULE_DUPLICATED'); assert.equal(rows[0].reminderId, reminderId)
    assert.equal(rows[0].dueAtUtc, new Date(`${tomorrow()}T10:00:00+08:00`).toISOString(), 'RESCHEDULE_TIME')
    assert.equal(rows[0].scheduleVersion, 2); assert.equal(rows[0].status, 'scheduled')
  })
  await turn('cancel', '取消刚才那条给植物浇水的提醒。', (rows, reply) => {
    assert.equal(rows.length, 1); assert.equal(rows[0].reminderId, reminderId); assert.equal(rows[0].status, 'cancelled')
    assert.doesNotMatch(reply, /(?:已被|已经|已|成功)\s*删除/, 'CANCEL_IS_NOT_DATA_DELETION')
  })
  }
  await turn('follow_up', '明天上午十一点回来问我一次合成验收是否完成，约一次回访，不要重复提醒。', rows => {
    assert.equal(rows.length, reminderId ? 2 : 1); const row = rows.find(value => value.reminderId !== reminderId)
    assert.equal(items.reminderToolView(row.reminderId).kind, 'follow_up', 'FOLLOWUP_KIND')
    assert.equal(row.dueAtUtc, new Date(`${tomorrow()}T11:00:00+08:00`).toISOString(), 'FOLLOWUP_TIME')
  })
  await turn('ambiguous_time', '明晚再提醒我看一眼合成验收日志。', (rows, reply) => {
    assert.equal(rows.length, reminderId ? 2 : 1, 'AMBIGUOUS_TIME_MUST_NOT_CREATE')
    assert.match(reply, /几点|什么时间|具体.*时间|哪个.*时间/, 'AMBIGUOUS_TIME_MUST_CLARIFY')
  })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0, 'UNREQUESTED_ITEM_WRITE')
  console.log(JSON.stringify({ status: 'passed', scope: 'real_ark_M01_reminder_lifecycle', phases: reminderId ? 5 : 2, unsolicitedItems: 0,
    sameReminderIdentity: reminderId ? true : null, database: 'isolated-in-memory', physicalPlaybackAcceptance: 'not_tested' }))
} catch (error) {
  console.log(JSON.stringify({ status: 'failed', code: String(error.code ?? error.message), calls, database: 'isolated-in-memory' }))
  process.exitCode = 1
} finally { tasks.close(); db.close() }
