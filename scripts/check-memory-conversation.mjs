// Real Ark calls with synthetic facts only. No personal history or credentials are printed.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1MemoryStore } from '../dist-electron/main/r1/memory.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { R1ConversationDriver } from '../dist-electron/main/r1/conversationDriver.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
const endpoint = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'ark.cn-beijing.volces.com') throw new Error('OFFICIAL_ENDPOINT_REQUIRED')
const db = openR1Database(':memory:'), memory = new R1MemoryStore(db), conversations = new R1Conversations(db)
const assets = loadR1PromptAssets(resolve('r1-assets')), sessionId = conversations.start()
const tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch())
const persona = { assistantName: 'Seamo AI', userAddress: '', style: '自然、简洁', voiceId: '', version: 1 }
const driver = new R1ConversationDriver(db, assets, tasks, createArkResponsesProvider({ timeoutMs: 30000, fetch: async (url, init) => {
  const response = await fetch(url, init)
  if (process.env.SEAMO_CHECK_DIAGNOSTIC === '1') {
    const body = await response.clone().json()
    console.log(JSON.stringify({ syntheticCalls: (body.output ?? []).filter(item => item.type === 'function_call').map(item => ({ name: item.name, arguments: JSON.parse(item.arguments) })) }))
  }
  return response
} }), () => persona, [])
try {
  if (process.env.SEAMO_CHECK_FROM === 'correct') {
    const seed = conversations.append({ sessionId, turnId: randomUUID(), role: 'user', body: '请记住，我喜欢无糖茶。', status: 'final' })
    memory.remember({ content: '用户喜欢无糖茶', category: 'preference', sourceMessageIds: [seed.messageId] })
    console.log(JSON.stringify({ setup: 'synthetic_prior_state_for_failed_correction_case', realCallsSkipped: ['remember', 'recall'] }))
  }
  for (const [phase, text] of [
    ['remember', '请记住，我喜欢无糖茶。'],
    ['recall', '我喜欢什么茶？'],
    ['correct', '更正关于茶的记忆，我现在喜欢无糖绿茶。'],
    ['forget', '忘记我关于茶的喜好记忆。'],
    ['after_forget', '你还记得我的茶的偏好吗？']
  ]) {
    if (process.env.SEAMO_CHECK_FROM === 'correct' && ['remember', 'recall'].includes(phase)) continue
    const source = conversations.append({ sessionId, turnId: randomUUID(), role: 'user', body: text, status: 'final' })
    let epoch = memory.currentDeletionEpoch()
    const scope = { source, timezone: 'Asia/Shanghai', temporary: false, persistenceConfirmed: false,
      assertCurrent() { if (epoch !== memory.currentDeletionEpoch()) throw new Error('SESSION_CHANGED') },
      onMemoryInvalidated(next) { epoch = next; tasks.invalidateContext() } }
    const recentTurns = conversations.modelTurns(sessionId)
    const context = { sessionId, sessionGeneration: 1, turnId: source.turnId, currentTime: source.createdAt,
      timezone: scope.timezone, temporary: false, contextVersion: epoch + 1, personaVersion: 1, deletionEpoch: epoch,
      selectedEntity: null, availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns, memories: [], activeTasks: [] }
    const start = performance.now()
    const result = await driver.reply({ scope, context, messages: recentTurns.filter(turn => turn.text.trim()).map(turn => ({ role: turn.role, content: turn.text })) })
    conversations.append({ sessionId, turnId: source.turnId, role: 'assistant', body: result.reply, status: 'generated' })
    const entries = memory.list().entries
    const passed = phase === 'remember' ? entries.length === 1 && /无糖.*茶/.test(entries[0].content) :
      phase === 'recall' ? /无糖.*茶/.test(result.reply) :
      phase === 'correct' ? entries.length === 1 && entries[0].version >= 2 && /绿茶/.test(entries[0].content) && memory.currentDeletionEpoch() > 0 :
      phase === 'forget' ? entries.length === 0 && memory.currentDeletionEpoch() >= 2 :
      entries.length === 0 && !/你.*喜欢.*(?:无糖茶|绿茶)/.test(result.reply)
    console.log(JSON.stringify({ phase, status: passed ? 'passed' : 'failed', memoryCount: entries.length,
      memories: entries.map(({ content, version }) => ({ content, version })), deletionEpoch: memory.currentDeletionEpoch(),
      finalReply: result.reply, elapsedMs: Math.round(performance.now() - start), database: 'isolated-in-memory',
      scope: 'ark_text_memory_chain', assetReleaseId: assets.releaseId }))
    if (!passed) { process.exitCode = 1; break }
  }
} catch (error) { console.log(JSON.stringify({ status: 'failed', code: error.code ?? error.message })); process.exitCode = 1 }
finally { tasks.close(); db.close() }
