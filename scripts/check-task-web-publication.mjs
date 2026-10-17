// One real M02 search/read/publication chain. Public synthetic request and isolated SQLite; no fixtures/profile writes.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1PersonaStore } from '../dist-electron/main/r1/persona.js'
import { R1Items } from '../dist-electron/main/r1/items.js'
import { R1Artifacts } from '../dist-electron/main/r1/artifacts.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1TaskToolExecutor } from '../dist-electron/main/r1/taskToolExecutor.js'
import { createDoubaoSearchProvider } from '../dist-electron/main/providers/doubaoSearchProvider.js'
import { createPageReader } from '../dist-electron/main/providers/pageReader.js'
import { R1TaskRunner } from '../dist-electron/main/r1/taskRunner.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
const base = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
if (base.protocol !== 'https:' || base.hostname !== 'ark.cn-beijing.volces.com') throw new Error('OFFICIAL_ENDPOINT_REQUIRED')
const db = openR1Database(':memory:')
const assets = loadR1PromptAssets(resolve('r1-assets'))
const tasks = new R1TaskSupervisor(db, assets, () => 0)
const provider = createArkResponsesProvider({ timeoutMs: 60000 })
const calls = []; const drafts = []; const diagnostics = []; let decisions = 0
const runner = new R1TaskRunner(tasks, assets, new R1TaskToolExecutor(tasks, assets, new R1Items(db), createDoubaoSearchProvider({resultLimit:3}), createPageReader()),
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
    body: '查找 RFC 9110 HTTP Semantics 的 RFC Editor 官方标准页，必须实际读取官方网页正文核对标题，再给出有真实来源的候选供选择，先不要保存或创建提醒。' })
  runner.start()
  const start = performance.now()
  const accepted = tasks.accept({ requestKey: randomUUID(), sourceMessageId: source.messageId,
    timezone: 'Asia/Shanghai', goal: source.body, constraints: ['只查询RFC Editor官方来源，不保存、不创建提醒'],
    complexity: 'complex', authorizedAliases: ['read_file', 'web_search', 'web_read_page'],
    requiredActions: [] })
  await runner.idle()
  const final = tasks.get(accepted.taskId)
  const items = new R1Items(db).list()
  const success = ['succeeded','partially_succeeded'].includes(final.status) && calls.includes('web_search') && final.webResult?.candidates.length > 0 && items.length === 0

  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), status: success ? 'passed' : 'failed',
    scope: 'isolated_real_M02_search_read_publication_with_production_default', candidateCount: final.webResult?.candidates.length ?? 0, sourceCount: final.webResult?.sources.length ?? 0, initialStatus: accepted.status, finalStatus: final.status,
    decisions, tools: calls, realItemRows: items.length,
    realReceiptRows: db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n,
    unresolvedCodes: final.result?.unresolved ?? [], drafts, diagnostics, store: false, publishedInProduction: false,
    elapsedMs: Math.round(performance.now() - start) }))
  if (!success) process.exitCode = 1
} finally { tasks.close(); await runner.close(); db.close() }
