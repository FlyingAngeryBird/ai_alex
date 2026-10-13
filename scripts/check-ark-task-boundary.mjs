// Opt-in synthetic M02 check. No task or artifact is published from this protocol check.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
import { R1TaskRequestBoundary } from '../dist-electron/main/r1/taskBoundary.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
const base = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
if (base.protocol !== 'https:' || base.hostname !== 'ark.cn-beijing.volces.com') throw new Error('OFFICIAL_ENDPOINT_REQUIRED')
const assets = loadR1PromptAssets(resolve('r1-assets'))
const input = { taskId: randomUUID(), runId: randomUUID(), goalVersion: 1, contextVersion: 1,
  deletionEpoch: 0, status: 'running', goal: '整理一份三步的本地连接检测操作说明，不查外部事实，不执行保存或播放。',
  constraints: ['仅生成说明草稿；没有实际执行任何步骤'], sourceRefs: [], currentTime: new Date().toISOString(),
  timezone: 'Asia/Shanghai', temporary: true,
  budget: { decisionsRemaining: 1, toolsRemaining: 0, activeMsRemaining: 30000, searchQueriesRemaining: 0, pagesRemaining: 0 },
  validReceiptActionIds: [], observations: [], loadedSkillIds: [] }
const boundary = new R1TaskRequestBoundary(assets, { assistantName: 'Seamo AI', userAddress: '',
  style: '简洁', voiceId: '', version: 1 }, input, [], () => ({ ...input, authorizedAliases: [], activeMsRemaining: 30000 }))
const start = performance.now()
const response = await createArkResponsesProvider({ timeoutMs: 30000 }).request({ boundary,
  messages: [{ role: 'user', content: input.goal }] })
if (response.calls.length) throw new Error('UNEXPECTED_TOOL_CALL')
const draft = JSON.parse(response.text)
assets.validateStructured('task-draft', draft)
if (draft.goalVersion !== 1 || draft.sourceRefs.length || draft.receiptActionIds.length) throw new Error('UNVERIFIED_REFERENCES')
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), status: 'passed', scope: 'task_boundary_schema_only',
  store: false, protocol: 'ark-responses-v3', promptIds: boundary.diagnostic.promptIds,
  assetReleaseId: assets.releaseId, toolCount: 0, draftSchemaValid: true, published: false,
  elapsedMs: Math.round(performance.now() - start) }))
