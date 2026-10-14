// Uses synthetic turns and an isolated database. No user history, notifications, or credentials are printed.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1ConversationDriver } from '../dist-electron/main/r1/conversationDriver.js'
import { R1Items } from '../dist-electron/main/r1/items.js'
const base = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
if (base.protocol !== 'https:' || base.hostname !== 'ark.cn-beijing.volces.com') throw new Error('OFFICIAL_ENDPOINT_REQUIRED')
for (const [caseId, text, expectCount] of [
  ['explicit_time', '明天晚上八点提醒我给合成验收用的植物浇水。', 1],
  ['missing_clock', '明晚提醒我给合成验收用的植物浇水。', 0]
]) {
  if (process.env.SEAMO_CHECK_CASE && process.env.SEAMO_CHECK_CASE !== caseId) continue
  const db = openR1Database(':memory:'), assets = loadR1PromptAssets(resolve('r1-assets'))
  const conversations = new R1Conversations(db), tasks = new R1TaskSupervisor(db, assets, () => 0)
  try {
    const persona = { assistantName: 'Seamo AI', userAddress: '', style: '自然、简洁', voiceId: '', version: 1 }
    const source = conversations.append({ sessionId: conversations.start(), turnId: randomUUID(), role: 'user', body: text, status: 'final' })
    const scope = { source, sourceMessages: [source], timezone: 'Asia/Shanghai', temporary: false, persistenceConfirmed: false, assertCurrent() {} }
    const context = { sessionId: source.sessionId, sessionGeneration: 1, turnId: source.turnId,
      currentTime: source.createdAt, timezone: scope.timezone, temporary: false, contextVersion: 1,
      personaVersion: 1, deletionEpoch: 0, selectedEntity: null, availableToolAliases: [], loadedSkillIds: ['SK01'],
      recentTurns: conversations.modelTurns(source.sessionId), memories: [], activeTasks: [] }
    const driver = new R1ConversationDriver(db, assets, tasks, createArkResponsesProvider({ timeoutMs: 30000, fetch: async (url, init) => {
      const response = await fetch(url, init)
      const body = await response.clone().json()
      const calls = (body.output ?? []).filter(item => item.type === 'function_call').map(item => ({ name: item.name, arguments: JSON.parse(item.arguments) }))
      if (process.env.SEAMO_CHECK_DIAGNOSTIC === '1') console.log(JSON.stringify({ caseId, calls }))
      return response
    } }), () => persona, [])
    const start = performance.now()
    const result = await driver.reply({ scope, context, messages: [{ role: 'user', content: text }] })
    const reminders = new R1Items(db).listReminders()
    const passed = reminders.length === expectCount && tasks.list().length === 0 &&
      (expectCount !== 0 || /几点|什么时间|具体.*时间|哪个.*时间/.test(result.reply))
    console.log(JSON.stringify({ caseId, status: passed ? 'passed' : 'failed', scope: 'ark_text_to_isolated_reminder',
      reminderCount: reminders.length, taskCount: tasks.list().length, dueAt: reminders[0]?.dueAtUtc ?? null,
      timezone: reminders[0]?.timezone ?? null, finalReply: result.reply, elapsedMs: Math.round(performance.now() - start),
      assetReleaseId: assets.releaseId, database: 'isolated-in-memory', notifications: 'not_started' }))
    if (!passed) process.exitCode = 1
  } catch (error) {
    console.log(JSON.stringify({ caseId, status: 'failed', code: error.code ?? error.message })); process.exitCode = 1
  } finally { tasks.close(); db.close() }
}
