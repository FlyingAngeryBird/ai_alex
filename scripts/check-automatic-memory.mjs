// Registered PR05, actual Ark, synthetic input and isolated databases. Never sends user history or prints credentials.
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1MemoryStore } from '../dist-electron/main/r1/memory.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1AutomaticMemory } from '../dist-electron/main/r1/automaticMemory.js'
import { R1PersonaStore } from '../dist-electron/main/r1/persona.js'
import { R1MemoryConfirmations } from '../dist-electron/main/r1/memoryConfirmations.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'
const endpoint = new URL(process.env.VOLCENGINE_ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3')
if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'ark.cn-beijing.volces.com') throw new Error('OFFICIAL_ENDPOINT_REQUIRED')
const cases = [
  ['clear_preference', '我平时喜欢喝无糖茶。', 'fact'],
  ['momentary_emotion', '今天真烦，什么都不想做。', 'empty'],
  ['quoted_source', '我读到一篇文章，里面写着：“我喜欢甜饮料。”这是作者的原话。', 'empty'],
  ['unclarified_irony', '对对对，我最喜欢加班了，呵呵。', 'empty'],
  ['sensitive_mix', '我有偏头痛。我平时喜欢喝无糖茶。', 'sensitive'],
  ['default_off', '我喜欢茶。', 'off'],
  ['temporary', '我喜欢茶。', 'temporary']
]
for (const [caseId, body, expected] of cases) {
  if (process.env.SEAMO_CHECK_CASE && process.env.SEAMO_CHECK_CASE !== caseId) continue
  const db = openR1Database(':memory:'), memory = new R1MemoryStore(db), conversations = new R1Conversations(db), persona = new R1PersonaStore(db), assets = loadR1PromptAssets(resolve('r1-assets'))
  const sessionId = conversations.start(expected === 'temporary'), source = conversations.append({ sessionId, turnId: randomUUID(), role: 'user', body, status: 'final' })
  let pending = null, requestCount = 0
  const manager = new R1MemoryConfirmations(db, { notify(_owner, value) { pending = value }, onInvalidated() {}, onTemporaryExited() {} })
  const provider = createArkResponsesProvider({ timeoutMs: 30000, fetch: (...args) => { requestCount++; return globalThis.fetch(...args) } })
  const automatic = new R1AutomaticMemory(db, assets, conversations, provider, { persona: () => persona.get(), configurationRevision: () => 1, onInvalidated() {}, onSaved() {} })
  try {
    if (expected !== 'off') automatic.updatePolicy({ enabled: true, expectedVersion: 1 })
    const start = performance.now()
    automatic.enqueue({ source, temporary: expected === 'temporary', timezone: 'Asia/Shanghai', assertSession() {}, assertLatest() {},
      confirmSensitive() { manager.offerSelection({ ownerId: 7, source, temporary: false, sensitive: true, automatic: true, assertCurrent() { automatic.assertAuthorized(2) } }) } })
    await automatic.whenIdle()
    const records = memory.list().entries, state = automatic.getState()
    const passed = expected === 'fact' ? records.length === 1 && records[0].category === 'preference' && records[0].authorization === 'automatic' && /无糖茶/.test(records[0].content) :
      expected === 'sensitive' ? !records.length && pending?.requiresSelection === true : !records.length && !pending && (expected === 'off' || expected === 'temporary' ? requestCount === 0 : state.state === 'idle')
    console.log(JSON.stringify({ caseId, status: passed ? 'passed' : 'failed', elapsedMs: Math.round(performance.now() - start), requestCount,
      memoryCount: records.length, syntheticMemories: records.map(record => ({ content: record.content, category: record.category, authorization: record.authorization })),
      sensitiveSelection: pending?.requiresSelection ?? false, state, assetReleaseId: assets.releaseId,
      scope: 'actual_ark_registered_extraction_to_domain_commit_synthetic_input' }))
    if (!passed) process.exitCode = 1
  } finally { automatic.close(); db.close() }
}
