// Opt-in real M02 check. Synthetic source and isolated in-memory DB only.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1PersonaStore } from '../dist-electron/main/r1/persona.js'
import { R1Items } from '../dist-electron/main/r1/items.js'
import { R1Artifacts } from '../dist-electron/main/r1/artifacts.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1TaskToolExecutor } from '../dist-electron/main/r1/taskToolExecutor.js'
import { R1TaskRunner } from '../dist-electron/main/r1/taskRunner.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
const base = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
if (base.protocol !== 'https:' || base.hostname !== 'ark.cn-beijing.volces.com') throw new Error('OFFICIAL_ENDPOINT_REQUIRED')
const db = openR1Database(':memory:')
const assets = loadR1PromptAssets(resolve('r1-assets'))
const tasks = new R1TaskSupervisor(db, assets, () => 0)
const provider = createArkResponsesProvider({ timeoutMs: 30000 })
const calls = []; const drafts = []; const diagnostics = []; let decisions = 0
const runner = new R1TaskRunner(tasks, assets, new R1TaskToolExecutor(tasks, assets, new R1Items(db)),
  new R1Artifacts(db), { async request(input) {
    decisions++
    const response = await provider.request(input)
    calls.push(...response.calls.map(call => call.name))
    if (response.text) try {
      const draft = JSON.parse(response.text)
      drafts.push({ status: draft.status, goalVersion: draft.goalVersion,
        artifactBases: (draft.artifacts ?? []).map(artifact => ({ id: artifact.baseArtifactId, version: artifact.baseArtifactVersion })) })
    } catch { drafts.push({ invalidJson: true }) }
    return response
  } }, () => new R1PersonaStore(db).get(), { onDiagnostic: event => diagnostics.push({ kind: event.kind, code: event.code }) })
try {
  const conversations = new R1Conversations(db)
  const source = conversations.append({ sessionId: conversations.start(), turnId: randomUUID(), role: 'user', status: 'final',
    body: '这是一次合成测试。我明确要求：先读取已注册 capture-item Skill 的完整正文，下一轮再按其规范调用 notes_create，只创建一条便签，标题“R1链路检查”，正文“合成测试正文”。不查外网、不设提醒、不播放音乐。创建后用真实回执说明结果，不要再重复创建。' })
  runner.start()
  const start = performance.now()
  const accepted = tasks.accept({ requestKey: randomUUID(), sourceMessageId: source.messageId,
    timezone: 'Asia/Shanghai', goal: source.body, constraints: ['仅创建一条合成便签；不要重复创建'],
    complexity: 'complex', authorizedAliases: ['read_file', 'write_todos', 'notes_create'],
    requiredActions: [{ alias: 'notes_create', minimumCount: 1 }] })
  await runner.idle()
  const final = tasks.get(accepted.taskId)
  const items = new R1Items(db).list()
  const success = final.status === 'succeeded' && calls.includes('read_file') && calls.includes('notes_create') &&
    items.length === 1 && items[0].title === 'R1链路检查' && items[0].body === '合成测试正文'
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), status: success ? 'passed' : 'failed',
    scope: 'isolated_M02_background_runner_note_commit', initialStatus: accepted.status, finalStatus: final.status,
    decisions, tools: calls, realItemRows: items.length,
    realReceiptRows: db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n,
    unresolvedCodes: final.result?.unresolved ?? [], drafts, diagnostics, store: false, publishedInProduction: false,
    elapsedMs: Math.round(performance.now() - start) }))
  if (!success) process.exitCode = 1
} finally { tasks.close(); await runner.close(); db.close() }
