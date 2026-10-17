// Synthetic cases only, actual Ark plus the same domain confirmation service. No personal history/keys are printed.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1MemoryStore } from '../dist-electron/main/r1/memory.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1MemoryConfirmations } from '../dist-electron/main/r1/memoryConfirmations.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1ConversationDriver } from '../dist-electron/main/r1/conversationDriver.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
const endpoint = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'ark.cn-beijing.volces.com') throw new Error('OFFICIAL_ENDPOINT_REQUIRED')
for (const [caseId, temporary, text] of [['sensitive_cancel', false, '请记住，我对花生过敏。'], ['temporary_confirm', true, '请记住，我喜欢无糖茶。']]) {
  if (process.env.SEAMO_CHECK_CASE && process.env.SEAMO_CHECK_CASE !== caseId) continue
  const db = openR1Database(':memory:'), memory = new R1MemoryStore(db), conversations = new R1Conversations(db), assets = loadR1PromptAssets(resolve('r1-assets'))
  const sessionId = conversations.start(temporary), tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch())
  let pending = null, mode = temporary
  const manager = new R1MemoryConfirmations(db, { notify(_owner, value) { pending = value }, onInvalidated() {}, onTemporaryExited() {} })
  manager.bindTemporaryExit(() => { conversations.end(sessionId); mode = false })
  try {
    if (temporary) conversations.append({ sessionId, turnId: randomUUID(), role: 'user', body: '合成的另外一段临时内容，不能写入历史。', status: 'final' })
    const source = conversations.append({ sessionId, turnId: randomUUID(), role: 'user', body: text, status: 'final' })
    const scope = { source, timezone: 'Asia/Shanghai', temporary, persistenceConfirmed: false,
      assertCurrent() { if (mode !== temporary) throw new Error('CONTEXT_CHANGED') },
      requestMemoryConfirmation(candidate, sensitive) { return manager.offer(candidate, { ownerId: 7, source, temporary, sensitive, assertCurrent: scope.assertCurrent }) } }
    const persona = { assistantName: 'Seamo AI', userAddress: '', style: '自然、简洁', voiceId: '', version: 1 }
    const context = { sessionId, sessionGeneration: 1, turnId: source.turnId, currentTime: source.createdAt,
      timezone: scope.timezone, temporary, contextVersion: 1, personaVersion: 1, deletionEpoch: 0,
      selectedEntity: null, availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: conversations.modelTurns(sessionId), memories: [], activeTasks: [] }
    const driver = new R1ConversationDriver(db, assets, tasks, createArkResponsesProvider({ timeoutMs: 30000 }), () => persona, [])
    const start = performance.now()
    const reply = await driver.reply({ scope, context, messages: [{ role: 'user', content: text }] })
    if (!pending || memory.list().entries.length || !reply.reply.includes('还没有保存')) throw new Error('PENDING_WITHOUT_WRITE_REQUIRED')
    const view = pending
    if (temporary) manager.commit(7, view.confirmationId); else manager.cancel(7, view.confirmationId)
    const passed = temporary ? !mode && memory.list().entries.length === 1 &&
      !JSON.stringify(db.prepare('SELECT body FROM messages').all()).includes('另外一段临时内容') : view.sensitive && memory.list().entries.length === 0
    console.log(JSON.stringify({ caseId, status: passed ? 'passed' : 'failed', pendingContent: view.content, pendingSensitive: view.sensitive,
      memoryCount: memory.list().entries.length, temporaryAfter: mode, finalReply: reply.reply, elapsedMs: Math.round(performance.now() - start),
      scope: 'ark_to_domain_confirmation_with_scripted_user_choice', database: 'isolated-in-memory', assetReleaseId: assets.releaseId }))
    if (!passed) process.exitCode = 1
  } catch (error) { console.log(JSON.stringify({ caseId, status: 'failed', code: error.code ?? error.message })); process.exitCode = 1 }
  finally { tasks.close(); db.close() }
}
