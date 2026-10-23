// Actual Ark M01 -> Task -> M02 with synthetic material and an isolated in-memory database.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1Artifacts } from '../dist-electron/main/r1/artifacts.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1TaskToolExecutor } from '../dist-electron/main/r1/taskToolExecutor.js'
import { R1TaskRunner } from '../dist-electron/main/r1/taskRunner.js'
import { R1ConversationDriver } from '../dist-electron/main/r1/conversationDriver.js'
import { R1PersonaStore } from '../dist-electron/main/r1/persona.js'
import { artifactParagraph } from '../dist-electron/main/r1/artifactContext.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
const endpoint = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'ark.cn-beijing.volces.com') throw new Error('OFFICIAL_ENDPOINT_REQUIRED')
const db = openR1Database(':memory:'), conversations = new R1Conversations(db), artifacts = new R1Artifacts(db), assets = loadR1PromptAssets(resolve('r1-assets'))
const persona = new R1PersonaStore(db), tasks = new R1TaskSupervisor(db, assets, () => 0, { artifacts })
const executor = new R1TaskToolExecutor(tasks, assets), requests = []
const provider = createArkResponsesProvider({ timeoutMs: 30000, fetch: async (url, init) => {
  const request = JSON.parse(String(init.body)), response = await fetch(url, init)
  const body = await response.clone().json()
  requests.push({ tools: (body.output ?? []).filter(item => item.type === 'function_call').map(item => item.name), store: request.store })
  if (process.env.SEAMO_CHECK_DIAGNOSTIC === '1') console.log(JSON.stringify({ syntheticCalls: (body.output ?? []).filter(item => item.type === 'function_call').map(item => ({ name: item.name, arguments: JSON.parse(item.arguments) })) }))
  return response
} })
const runner = new R1TaskRunner(tasks, assets, executor, artifacts, provider, () => persona.get(), { onDiagnostic: event => console.log(JSON.stringify({ diagnostic: event.code })) })
try {
  const mode = { temporary: false, sessionId: conversations.start() }
  const original = '第一段：本轮只做中文 macOS 内部验收，先邀请三位同事试用。🙂\n\n第二段：我们需要逐一验证文字输入、生成回复、工作稿编辑、撤销和导出，还要检查版本冲突以及数据备份恢复，每一项都要留下验证记录。\n\n第三段：验收完成前暂不提供公开下载，也不启动移动版。'
  const initial = conversations.append({ sessionId: mode.sessionId, turnId: randomUUID(), role: 'user', body: original, status: 'final' })
  const artifact = artifacts.create({ sourceTurnId: initial.turnId, draft: { kind: 'text', title: '内部验收安排', content: original,
    sourceRefs: [initial.messageId], baseArtifactId: null, baseArtifactVersion: null } })
  mode.selectedArtifact = { artifactId: artifact.artifactId, version: 1, selection: null }
  const source = conversations.append({ sessionId: mode.sessionId, turnId: randomUUID(), role: 'user', body: '第二段短一些，其他内容和标题都不变。', status: 'final' })
  const driver = new R1ConversationDriver(db, assets, tasks, provider, () => persona.get(), executor.implementedAliases, undefined, artifacts)
  const currentArtifact = driver.artifactContext(mode), started = performance.now()
  const reply = await driver.reply({ scope: { source, temporary: false, timezone: 'Asia/Shanghai', persistenceConfirmed: false, assertCurrent() {} },
    messages: [{ role: 'user', content: source.body }], context: { sessionId: mode.sessionId, sessionGeneration: 1, turnId: source.turnId,
      currentTime: source.createdAt, timezone: 'Asia/Shanghai', temporary: false, contextVersion: 1, personaVersion: persona.get().version, deletionEpoch: 0,
      selectedEntity: { type: 'artifact', id: artifact.artifactId, version: 1 }, currentArtifact,
      availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: [], memories: [], topics: [], activeTasks: [] } })
  if (tasks.list().length !== 1) throw new Error('EXPECTED_SINGLE_EDIT_TASK')
  const accepted = tasks.list()[0]
  console.log(JSON.stringify({ phase: 'accepted', status: accepted.status, reply: reply.reply, elapsedMs: Math.round(performance.now() - started) }))
  runner.start(); await runner.idle()
  const final = tasks.get(accepted.taskId), revised = artifacts.get(artifact.artifactId), range = artifactParagraph(original, 2)
  const prefix = [...original].slice(0, range.start).join(''), suffix = [...original].slice(range.end).join('')
  const replacement = revised.content.slice(prefix.length, revised.content.length - suffix.length)
  if (final.status !== 'succeeded' || revised.version !== 2 || revised.title !== artifact.title || !revised.content.startsWith(prefix) ||
    !revised.content.endsWith(suffix) || !replacement.trim() || [...replacement].length >= range.end - range.start || db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n !== 1) {
    console.log(JSON.stringify({ phase: 'failed', taskStatus: final.status, issues: final.result?.unresolved, brief: final.progressBrief, version: revised.version, requests }))
    throw new Error('ARTIFACT_CONTINUATION_NOT_VERIFIED')
  }
  console.log(JSON.stringify({ status: 'passed', scope: 'real_ark_M01_task_M02_synthetic_material', version: revised.version, sameArtifact: true,
    outsideTargetUnchanged: true, titleUnchanged: true, replacement, sourceCount: revised.sourceRefs.length, requestCount: requests.length,
    requests, elapsedMs: Math.round(performance.now() - started), assetReleaseId: assets.releaseId, productionDataUsed: false }))
} catch (error) { console.log(JSON.stringify({ status: 'failed', code: error.code ?? error.message, requests })); process.exitCode = 1 }
finally { tasks.close(); await runner.close(); db.close() }
