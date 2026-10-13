// Opt-in real provider check. Run with Node --env-file; never prints credentials or output text.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
import { R1ModelRequestBoundary } from '../dist-electron/main/r1/modelBoundary.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1MemoryStore } from '../dist-electron/main/r1/memory.js'
const base = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
if (base.protocol !== 'https:' || base.hostname !== 'ark.cn-beijing.volces.com') throw new Error('OFFICIAL_ENDPOINT_REQUIRED')
const assets = loadR1PromptAssets(resolve('r1-assets'))
const db = openR1Database(':memory:')
try {
  const memory = new R1MemoryStore(db)
  const context = { sessionId: randomUUID(), sessionGeneration: 1, turnId: randomUUID(),
    currentTime: new Date().toISOString(), timezone: 'Asia/Shanghai', temporary: false,
    contextVersion: 1, personaVersion: 1, deletionEpoch: 0, selectedEntity: null,
    availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: [], memories: [], activeTasks: [] }
  const boundary = new R1ModelRequestBoundary(assets, { assistantName: 'Seamo AI', userAddress: '',
    style: '自然、简洁', voiceId: '', version: 1 }, context, ['memory_recall'])
  const adapter = createArkResponsesProvider({ timeoutMs: 30_000 })
  const messages = [{ role: 'user', content: '请用可用的记忆查询工具检索“协议核验偏好”，根据实际查询结果回答，查不到就说明查不到。' }]
  const start = performance.now()
  const first = await adapter.request({ boundary, messages })
  if (!first.calls.length || first.calls.some(call => call.name !== 'memory_recall')) throw new Error('EXPECTED_RECALL_CALL_MISSING')
  const results = first.calls.map(call => {
    const args = JSON.parse(call.arguments)
    const memories = memory.recall(args.query)
    return { callId: call.call_id, output: { kind: 'receipt', actionId: randomUUID(), tool: 'memory.recall',
      status: 'succeeded', entityId: null, entityVersion: null, data: { memories, matchStatus: memories.length ? 'matched' : 'no_match' },
      errorCode: null, retryable: false, runId: null } }
  })
  const final = await adapter.request({ boundary, messages, rounds: [{ output: first.output, results }] })
  if (!final.text || final.calls.length) throw new Error('FINAL_RESPONSE_MISSING')
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), status: 'passed', store: false,
    protocol: 'ark-responses-v3', assetReleaseId: assets.releaseId, tool: 'memory_recall',
    callCount: first.calls.length, nativeCallIdsPaired: true, database: 'isolated-in-memory',
    finalTextCodePoints: [...final.text].length, elapsedMs: Math.round(performance.now() - start) }))
} finally { db.close() }
