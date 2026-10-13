// Opt-in real model loop with isolated SQLite and registered internal tools. No production user data.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1TaskToolExecutor } from '../dist-electron/main/r1/taskToolExecutor.js'
import { R1Artifacts } from '../dist-electron/main/r1/artifacts.js'
import { R1PersonaStore } from '../dist-electron/main/r1/persona.js'
import { R1TaskRequestBoundary } from '../dist-electron/main/r1/taskBoundary.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
const base = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
if (base.protocol !== 'https:' || base.hostname !== 'ark.cn-beijing.volces.com') throw new Error('OFFICIAL_ENDPOINT_REQUIRED')
const db = openR1Database(':memory:')
const assets = loadR1PromptAssets(resolve('r1-assets'))
const tasks = new R1TaskSupervisor(db, assets, () => 0)
try {
  const conversation = new R1Conversations(db)
  const source = conversation.append({ sessionId: conversation.start(), turnId: randomUUID(), role: 'user', status: 'final',
    body: '请先通过已注册的只读工具读取 work-discussion Skill 正文，再按照它的指导帮我整理一份三步的本地连接检测操作说明，作为可编辑讨论稿，不查外部事实，也不要保存为事项或播放。' })
  const accepted = tasks.accept({ requestKey: randomUUID(), sourceMessageId: source.messageId, timezone: 'Asia/Shanghai',
    goal: source.body, constraints: ['生成可编辑讨论稿；不查询、保存事项或播放'], complexity: 'complex', authorizedAliases: ['read_file', 'write_todos'] })
  const active = tasks.claimNext()
  const executor = new R1TaskToolExecutor(tasks, assets)
  const adapter = createArkResponsesProvider({ timeoutMs: 30000 })
  const persona = new R1PersonaStore(db).get()
  const rounds = []; const aliases = []; const toolChecks = []; const start = performance.now()
  for (let decision = 0; decision < 8; decision++) {
    const input = tasks.beginDecision(active.lease)
    const boundary = new R1TaskRequestBoundary(assets, persona, input, ['read_file', 'write_todos'], () => tasks.authority(accepted.taskId))
    const response = await adapter.request({ boundary, messages: [{ role: 'user', content: source.body }], rounds, signal: active.signal })
    if (response.calls.length) {
      const results = response.calls.map(call => {
        aliases.push(call.name)
        const output = executor.execute(active.lease, call.name, JSON.parse(call.arguments))
        toolChecks.push({ alias: call.name, filePath: JSON.parse(call.arguments).file_path,
          status: output.status, code: output.errorCode })
        return { callId: call.call_id, output }
      })
      rounds.push({ output: response.output, results }); continue
    }
    const draft = JSON.parse(response.text)
    const result = tasks.publish(active.lease, draft, new R1Artifacts(db))
    if (!aliases.includes('read_file')) throw new Error('EXPECTED_INTERNAL_TOOL_CALL_MISSING')
    if (result.completionStatus !== 'completed' || !result.artifacts.length) {
      console.log(JSON.stringify({ scope: 'synthetic_test_only', draftStatus: draft.status,
        toolChecks, diagnostic: draft.replyBrief.slice(0,500), unresolved: draft.unresolved }))
      throw new Error('EXPECTED_ARTIFACT_RESULT_MISSING')
    }
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), status: 'passed', scope: 'isolated_M02_internal_tools_publication',
      initialStatus: accepted.status, finalStatus: tasks.get(accepted.taskId).status,
      decisionCount: decision + 1, tools: aliases, artifacts: result.artifacts.length,
      realArtifactRows: db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n,
      realReceiptRows: db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n,
      store: false, publishedInProduction: false, elapsedMs: Math.round(performance.now() - start) }))
    break
  }
  if (tasks.get(accepted.taskId).status !== 'succeeded') throw new Error('TASK_LOOP_NOT_FINISHED')
} finally { tasks.close(); db.close() }
