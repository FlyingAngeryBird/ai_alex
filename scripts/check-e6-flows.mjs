// E6 small real-model set: persona, ambiguous topic recall, discussion-vs-draft behavior.
// Synthetic inputs and isolated in-memory DB only; never prints credentials or user data.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1MemoryStore } from '../dist-electron/main/r1/memory.js'
import { R1MemoryPolicy } from '../dist-electron/main/r1/memoryPolicy.js'
import { R1Topics } from '../dist-electron/main/r1/topics.js'
import { R1Artifacts } from '../dist-electron/main/r1/artifacts.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1ConversationDriver } from '../dist-electron/main/r1/conversationDriver.js'
import { R1PersonaStore } from '../dist-electron/main/r1/persona.js'
import { currentArtifactContext } from '../dist-electron/main/r1/artifactContext.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
const endpoint = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'ark.cn-beijing.volces.com') throw new Error('OFFICIAL_ENDPOINT_REQUIRED')
const db = openR1Database(':memory:'), conversations = new R1Conversations(db), memory = new R1MemoryStore(db)
const assets = loadR1PromptAssets(resolve('r1-assets')), topics = new R1Topics(db), artifacts = new R1Artifacts(db)
const memoryPolicy = new R1MemoryPolicy(db); memoryPolicy.update({ enabled: true, expectedVersion: 1 })
const persona = new R1PersonaStore(db)
persona.update({ assistantName: '阿澄', userAddress: '小海', style: '简短、温和，先回应感受', voiceId: '', expectedVersion: 1 })
const tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch(), { artifacts })
const provider = createArkResponsesProvider({ timeoutMs: 60000 })
const driver = new R1ConversationDriver(db, assets, tasks, provider, () => persona.get(), [], undefined, artifacts)
const results = []
function contextFor(sessionId, source, extra = {}) {
  const epoch = memory.currentDeletionEpoch()
  return { sessionId, sessionGeneration: 1, turnId: source.turnId, currentTime: source.createdAt, timezone: 'Asia/Shanghai', temporary: false,
    contextVersion: epoch + 1, personaVersion: persona.get().version, deletionEpoch: epoch, selectedEntity: null,
    availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: conversations.modelTurns(sessionId), memories: [], topics: [], activeTasks: [], ...extra }
}
async function reply(sessionId, text, extra = {}) {
  const source = conversations.append({ sessionId, turnId: randomUUID(), role: 'user', body: text, status: 'final' })
  const start = performance.now()
  const result = await driver.reply({ scope: { source, temporary: false, timezone: 'Asia/Shanghai', persistenceConfirmed: false, assertCurrent() {} },
    messages: conversations.modelTurns(sessionId).filter(turn => turn.text.trim()).map(turn => ({ role: turn.role, content: turn.text })),
    context: contextFor(sessionId, source, extra) })
  conversations.append({ sessionId, turnId: source.turnId, role: 'assistant', body: result.reply, status: 'generated' })
  return { reply: result.reply, elapsedMs: Math.round(performance.now() - start) }
}
try {
  // F02b: same session: vent -> explicit advice -> identity/address. Persona is the single source.
  const personaSession = conversations.start()
  const vent = await reply(personaSession, '今天被同事当众否定，我特别难受，什么都不想干。')
  const ventChecks = { noUnrequestedTask: tasks.list().length === 0, respondsToFeeling: /难受|委屈|不容易|听到|抱抱|辛苦了|被否定/.test(vent.reply), noForcedAdvice: !/建议你(?:立刻|马上|先)|1[.、]|2[.、]/.test(vent.reply) }
  results.push({ area: 'F02b', case: 'vent', ...vent, checks: ventChecks, status: Object.values(ventChecks).every(Boolean) ? 'passed' : 'failed' })
  const advice = await reply(personaSession, '我现在想听听你的建议：怎么和这位同事沟通？')
  const adviceChecks = { offersAdvice: /建议|可以|试试|先|沟通|表达/.test(advice.reply), noUnrequestedTask: tasks.list().length === 0 }
  results.push({ area: 'F02b', case: 'explicit_advice', ...advice, checks: adviceChecks, status: Object.values(adviceChecks).every(Boolean) ? 'passed' : 'failed' })
  const identity = await reply(personaSession, '你是谁？平时怎么称呼我？各用一句话。')
  const identityChecks = { usesPersonaName: identity.reply.includes('阿澄'), usesUserAddress: identity.reply.includes('小海'),
    noOldName: !/灵粒|lingmo|Seamo AI/i.test(identity.reply), notClaimingHuman: !/我是人类|我是真人/.test(identity.reply) }
  results.push({ area: 'F02b', case: 'identity_address', ...identity, checks: identityChecks, status: Object.values(identityChecks).every(Boolean) ? 'passed' : 'failed' })

  // F04c: two real Topics; ambiguous question must ask one key clarification, not guess.
  const seedSession = conversations.start()
  const seedPlatform = conversations.append({ sessionId: seedSession, turnId: randomUUID(), role: 'user', body: '平台方案：先做中文 macOS 内部桌面版，移动版暂不安排，发布日期未定。', status: 'final' })
  topics.commitSummary({ result: { summary: seedPlatform.body, sourceTurnIds: [seedPlatform.turnId], memoryIds: [], taskFacts: [], topic: { topicId: null, expectedVersion: null, title: '平台方案', unresolved: ['发布日期未定'], status: 'active' } }, sources: [seedPlatform], existingTopics: [], authorizationVersion: memoryPolicy.get().version, deletionEpoch: memory.currentDeletionEpoch(), assertCurrent() {} })
  const seedBudget = conversations.append({ sessionId: seedSession, turnId: randomUUID(), role: 'user', body: '预算方案：先等正式报价再继续比较，不先承诺。', status: 'final' })
  topics.commitSummary({ result: { summary: seedBudget.body, sourceTurnIds: [seedBudget.turnId], memoryIds: [], taskFacts: [], topic: { topicId: null, expectedVersion: null, title: '预算方案', unresolved: ['等待正式报价'], status: 'active' } }, sources: [seedBudget], existingTopics: [], authorizationVersion: memoryPolicy.get().version, deletionEpoch: memory.currentDeletionEpoch(), assertCurrent() {} })
  conversations.end(seedSession)
  const topicSession = conversations.start()
  const ambiguous = await reply(topicSession, '之前那个方案现在到哪一步了？')
  const ambiguousChecks = { asksWhichTopic: /哪个|哪一个|哪一件|是指|指的是|平台方案.*预算方案|预算方案.*平台方案/.test(ambiguous.reply),
    asksOneClarifyingQuestion: (ambiguous.reply.match(/[?？]/g) ?? []).length === 1,
    noUnsupportedChoice: !/就(?:按|是).{0,8}(?:平台|预算)方案/.test(ambiguous.reply) }
  results.push({ area: 'F04c', case: 'ambiguous_two_topics', ...ambiguous, checks: ambiguousChecks, status: Object.values(ambiguousChecks).every(Boolean) ? 'passed' : 'failed' })
  const specific = await reply(topicSession, '平台方案现在到哪一步了？')
  const specificChecks = { answersPlatform: /macOS|桌面版|平台/.test(specific.reply), doesNotInventResolvedDate: !/发布(?:日期|时间).*(?:已经|已)定/.test(specific.reply) }
  results.push({ area: 'F04c', case: 'specific_after_ambiguity', ...specific, checks: specificChecks, status: Object.values(specificChecks).every(Boolean) ? 'passed' : 'failed' })

  // F09a: pure discussion with a current artifact must not create a Task or change the artifact.
  const artSession = conversations.start()
  const original = '第一段：本轮先做中文 macOS 内部验收。\n\n第二段：邀请三位同事试用并记录反馈。\n\n第三段：验收完成前不公开下载。'
  const seed = conversations.append({ sessionId: artSession, turnId: randomUUID(), role: 'user', body: original, status: 'final' })
  const artifact = artifacts.create({ sourceTurnId: seed.turnId, draft: { kind: 'text', title: '验收安排', content: original, sourceRefs: [seed.messageId], baseArtifactId: null, baseArtifactVersion: null } })
  const mode = { temporary: false, sessionId: artSession, selectedArtifact: { artifactId: artifact.artifactId, version: artifact.version, selection: null } }
  const currentArtifact = currentArtifactContext(mode, artifacts)
  const beforeTasks = tasks.list().length, beforeArtifact = artifacts.get(artifact.artifactId)
  const discussion = await reply(artSession, '我们先讨论一下这份验收安排怎么取舍，不要改稿，也不要建任务。', { selectedEntity: { type: 'artifact', id: artifact.artifactId, version: artifact.version }, currentArtifact })
  const afterArtifact = artifacts.get(artifact.artifactId)
  const discussionChecks = { noTask: tasks.list().length === beforeTasks, artifactUnchanged: afterArtifact.version === beforeArtifact.version && afterArtifact.content === beforeArtifact.content && afterArtifact.title === beforeArtifact.title,
    discussesTradeoffs: /取舍|优先|第一段|第二段|第三段|建议|可以/.test(discussion.reply) }
  results.push({ area: 'F09a', case: 'discussion_only', ...discussion, checks: discussionChecks, status: Object.values(discussionChecks).every(Boolean) ? 'passed' : 'failed' })
  console.log(JSON.stringify({ scope: 'e6_small_real_model_set_synthetic_isolated', assetReleaseId: assets.releaseId, database: 'isolated-in-memory',
    microphoneOpened: false, productionDataUsed: false, results, passed: results.filter(x => x.status === 'passed').length, total: results.length }))
  if (results.some(x => x.status !== 'passed')) process.exitCode = 1
} catch (error) {
  console.log(JSON.stringify({ scope: 'e6_small_real_model_set_synthetic_isolated', status: 'failed', code: error.code ?? error.message, results }))
  process.exitCode = 1
} finally { tasks.close(); db.close() }
