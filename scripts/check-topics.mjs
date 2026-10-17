// Actual registered Ark PR06 and M01 with synthetic conversation sources and isolated databases.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1MemoryStore } from '../dist-electron/main/r1/memory.js'
import { R1MemoryPolicy } from '../dist-electron/main/r1/memoryPolicy.js'
import { R1Topics } from '../dist-electron/main/r1/topics.js'
import { R1TopicSummaries } from '../dist-electron/main/r1/topicSummaries.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1ConversationDriver } from '../dist-electron/main/r1/conversationDriver.js'
import { topicConversationContext } from '../dist-electron/main/r1/topicContext.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
const endpoint = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'ark.cn-beijing.volces.com') throw new Error('OFFICIAL_ENDPOINT_REQUIRED')
const ordinary = ['我们决定先做 macOS 桌面版。', '首版只面向中文内部使用。', '我希望支持文字交流和语音交流。', '暂时不做移动版。', '必须保留旧版代码和数据。', '先验证功能，再提供下载。', '发布日期还没有确定。', '当前决定先完成文字体验。', '这些就是我们已经确认的桌面版范围，发布日期仍未确定。']
const cases = [
  ['confirmed_topic', ordinary, true],
  ['quoted_material', Array.from({ length: 9 }, (_, i) => i === 8 ? '以上都是文章作者的观点，不是我的计划或决定。' : `第${i + 1}段是文章内容：“我想做桌面助手。”这里的我是作者。`), false],
  ['sensitive_health', Array.from({ length: 9 }, (_, i) => i === 8 ? '这些都是我的身体情况，我还会继续问医生。' : '医生告诉我，最近脑袋一跳一跳的情况要继续观察。'), false]
]
for (const [caseId, turns, expected] of cases) {
  if (process.env.SEAMO_CHECK_CASE && process.env.SEAMO_CHECK_CASE !== caseId) continue
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db), memory = new R1MemoryStore(db), topics = new R1Topics(db), assets = loadR1PromptAssets(resolve('r1-assets'))
  const policy = new R1MemoryPolicy(db), sessionId = conversations.start(); policy.update({ enabled: true, expectedVersion: 1 })
  let count = 0, proposal = null
  const provider = createArkResponsesProvider({ timeoutMs: assets.summaryWindow().requestTimeoutMs, fetch: async (...args) => {
    count++; const response = await globalThis.fetch(...args)
    try { const body = await response.clone().json(); const text = body.output?.filter(item => item.type === 'message').flatMap(item => item.content.map(part => part.text)).join('\n'); if (text) proposal = JSON.parse(text) } catch {}
    return response
  } })
  const summaries = new R1TopicSummaries(db, assets, conversations, provider, { personaVersion: () => 1, configurationRevision: () => 1, onChanged() {}, onInvalidated() {} })
  const tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch())
  try {
    const started = performance.now()
    for (const body of turns) {
      const source = conversations.append({ sessionId, turnId: randomUUID(), role: 'user', body, status: 'final' })
      summaries.enqueue({ source, temporary: false, assertSession() {} })
    }
    await summaries.whenIdle()
    const records = topics.list().entries, state = summaries.getState()
    const passed = state.state === 'idle' && count === 1 && (expected ? records.length === 1 && /macOS|桌面/.test(records[0].summary) && records[0].unresolved.some(question => /日期|时间|发布/.test(question)) : records.length === 0)
    console.log(JSON.stringify({ caseId, status: passed ? 'passed' : 'failed', elapsedMs: Math.round(performance.now() - started), requestCount: count,
      proposalReferenceCounts: proposal ? { sourceTurns: proposal.sourceTurnIds?.length, memories: proposal.memoryIds?.length, taskFacts: proposal.taskFacts?.length, hasTarget: Boolean(proposal.topic?.topicId) } : null, topicCount: records.length, syntheticTopics: records.map(record => ({ title: record.title, summary: record.summary, unresolved: record.unresolved, version: record.version, sourceCount: record.sourceRefs.length })),
      state, assetReleaseId: assets.releaseId, database: 'isolated-in-memory', scope: 'actual_ark_registered_summary_and_domain_commit_synthetic_input' }))
    if (!passed) process.exitCode = 1
    if (caseId !== 'confirmed_topic' || !passed) continue
    const persona = { assistantName: 'Seamo AI', userAddress: '', style: '自然简洁', voiceId: '', version: 1 }
    const driver = new R1ConversationDriver(db, assets, tasks, provider, () => persona, [])
    let topic = records[0]
    for (const revision of ['original', 'corrected']) {
      if (revision === 'corrected') {
        const stageStart = performance.now()
        for (let i = 0; i < 9; i++) {
          const source = conversations.append({ sessionId, turnId: randomUUID(), role: 'user', body: '继续同一个 macOS 桌面版计划：发布日期已决定为2026年11月15日，先内部验收再生成安装包，当前仍不做移动版。', status: 'final' })
          summaries.enqueue({ source, temporary: false, assertSession() {} })
        }
        await summaries.whenIdle()
        const updated = topics.list().entries
        const updatedOkay = updated.length === 1 && updated[0].topicId === topic.topicId && updated[0].version === 2 && /11月15日|2026-11-15/.test(updated[0].summary)
        console.log(JSON.stringify({ caseId: 'automatic_stage_update', status: updatedOkay ? 'passed' : 'failed', elapsedMs: Math.round(performance.now() - stageStart),
          topicCount: updated.length, versions: updated.map(value => value.version), syntheticSummaries: updated.map(value => value.summary), state: summaries.getState() }))
        if (!updatedOkay) { process.exitCode = 1; break }
        topic = updated[0]
      }
      if (revision === 'corrected') topic = topics.update({ topicId: topic.topicId, expectedVersion: topic.version, title: topic.title,
        summary: '已确认先完成中文 macOS 桌面内部版，暂不做移动版。发布日期已经确定为下月中旬。', unresolved: [], status: 'resolved' })
      const source = conversations.append({ sessionId, turnId: randomUUID(), role: 'user', body: '接着这个话题聊。简短告诉我已确定的首版范围，以及发布日期是否已经确定。', status: 'final' })
      const topicData = topicConversationContext(db, { temporary: false, selectedTopic: { topicId: topic.topicId, version: topic.version } })
      const context = { sessionId, sessionGeneration: 1, turnId: source.turnId, currentTime: source.createdAt, timezone: 'Asia/Shanghai', temporary: false,
        contextVersion: 1, personaVersion: 1, deletionEpoch: memory.currentDeletionEpoch(), selectedEntity: topicData.selected,
        availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: [], memories: [], topics: topicData.topics, activeTasks: [] }
      const start = performance.now()
      const reply = await driver.reply({ scope: { source, timezone: 'Asia/Shanghai', temporary: false, persistenceConfirmed: false, assertCurrent() {} }, context,
        messages: [{ role: 'user', content: source.body }] })
      const okay = /macOS|桌面/.test(reply.reply) && (revision === 'original' ? /未确定|未定|待定|没(?:有)?确定|尚未/.test(reply.reply) : /下月中旬|下个月中旬|11月中旬/.test(reply.reply) && !/尚未确定|还未确定|仍未确定/.test(reply.reply))
      console.log(JSON.stringify({ caseId: `resume_${revision}`, status: okay ? 'passed' : 'failed', elapsedMs: Math.round(performance.now() - start), syntheticReply: reply.reply,
        topicVersion: topic.version, deletionEpoch: memory.currentDeletionEpoch(), scope: 'actual_ark_m01_selected_current_topic_synthetic_input' }))
      if (!okay) process.exitCode = 1
    }
  } finally { summaries.close(); tasks.close(); db.close() }
}
