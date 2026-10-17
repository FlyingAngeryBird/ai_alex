// Real M01 delete/export chain against the already configured credential vault.
// Isolated in-memory SQLite; synthetic Items and text; the trusted UI confirmation
// is exercised through the same R1ItemActions service the typed IPC calls.
// Requires a logged-in GUI session (headless Electron never reaches app.whenReady).
// Run: unset ELECTRON_RUN_AS_NODE && npx electron scripts/check-item-actions.mjs
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openR1Database } from '../dist-electron/main/r1/database.js'
import { R1Conversations } from '../dist-electron/main/r1/conversations.js'
import { R1Items } from '../dist-electron/main/r1/items.js'
import { R1Artifacts } from '../dist-electron/main/r1/artifacts.js'
import { R1TaskSupervisor } from '../dist-electron/main/r1/taskSupervisor.js'
import { R1ItemActions } from '../dist-electron/main/r1/itemActions.js'
import { R1ConversationDriver } from '../dist-electron/main/r1/conversationDriver.js'
import { loadR1PromptAssets } from '../dist-electron/main/r1/promptAssets.js'
import { CredentialVault } from '../dist-electron/main/r1/credentials.js'
import { createArkResponsesProvider } from '../dist-electron/main/providers/arkResponsesProvider.js'

await app.whenReady()
const LOG = '/tmp/seamo-item-actions-evidence.log'
writeFileSync(LOG, '')
const log = (value) => { try { appendFileSync(LOG, JSON.stringify(value) + '\n') } catch { /* diagnostics only */ } }
const report = { checkedAt: new Date().toISOString(), scope: 'isolated_real_M01_item_delete_and_export', microphoneOpened: false,
  userDatabaseWritten: false, searchUsed: false, audioPlayed: false }
const finish = (code, extra = {}) => { const value = JSON.stringify({ ...report, status: code, ...extra }); log({ final: value }); console.log(value); setTimeout(() => app.exit(0), 50) }
log({ stage: 'vault_loading' })
const vault = new CredentialVault(join(app.getPath('appData'), 'Seamo AI R1', 'credentials.bin'))
let credentialsReady = false
try { vault.load(); credentialsReady = true } catch { credentialsReady = false }
log({ stage: 'vault_loaded', available: credentialsReady })
if (!credentialsReady) finish('blocked_credentials_unavailable', { code: 'CREDENTIAL_VAULT_UNREADABLE' })
else try {
    const assets = loadR1PromptAssets(resolve('r1-assets'))
    const db = openR1Database(':memory:')
    const conversations = new R1Conversations(db), items = new R1Items(db), artifacts = new R1Artifacts(db)
    const tasks = new R1TaskSupervisor(db, assets, () => 0)
    const directory = mkdtempSync(join(tmpdir(), 'seamo-item-evidence-'))
    const pendingViews = []
    const calls = []
    const provider = createArkResponsesProvider({ timeoutMs: 30_000, fetch: async (url, init) => {
      const request = JSON.parse(String(init.body))
      const response = await fetch(url, init)
      const body = await response.clone().json()
      calls.push(...(body.output ?? []).filter(value => value.type === 'function_call')
        .map(value => ({ alias: value.name, args: JSON.parse(value.arguments) })))
      return response
    } })
    const actions = new R1ItemActions(db, items, artifacts, {
      notify: (_owner, view) => { if (view) pendingViews.push(view) },
      choose: async (_name, extension) => join(directory, `evidence.${extension}`),
      isSessionCurrent: () => true
    })
    const persona = { version: 1, assistantName: 'Seamo AI', userAddress: '', style: '自然简洁', voiceId: '' }
    log({ stage: 'runtime_ready', assetReleaseId: assets.releaseId })
    const driver = new R1ConversationDriver(db, assets, tasks, provider, () => persona, ['read_file', 'notes_list', 'notes_delete', 'notes_export'], undefined, artifacts)
    const sessionId = conversations.start()
    const scopeFor = (source) => ({ source, temporary: false, timezone: 'Asia/Shanghai', persistenceConfirmed: false,
      ownerId: 1, assertCurrent() {},
      requestItemAction: input => actions.offer({ ownerId: 1, sessionId, temporary: false, assertCurrent() {} }, input) })
    const turn = async (body, recentTurns = []) => {
      const source = conversations.append({ sessionId, turnId: randomUUID(), role: 'user', body, status: 'final' })
      pendingViews.length = 0; calls.length = 0
      const startedAt = Date.now()
      const result = await driver.reply({ scope: scopeFor(source),
        messages: [{ role: 'user', content: source.body }],
        context: { sessionId, sessionGeneration: 1, turnId: source.turnId, currentTime: source.createdAt,
          timezone: 'Asia/Shanghai', temporary: false, contextVersion: 1, personaVersion: 1, deletionEpoch: 0,
          selectedEntity: null, currentCandidate: null, availableToolAliases: [], loadedSkillIds: ['SK01'],
          recentTurns, memories: [], topics: [], activeTasks: [] } })
      return { result, elapsedMs: Date.now() - startedAt, calls: [...calls], view: pendingViews.at(-1) ?? null }
    }
    // 1) Real M01 asks to delete a synthetic Item; the model only prepares the UI confirmation.
    const target = items.create({ actionId: 'synthetic-delete', kind: 'note', title: '合成购物验收', body: '明天买茶' }).item
    log({ stage: 'delete_turn_start' })
    const deleted = await turn('把「合成购物验收」这条记录删掉，提醒先保留。')
    report.deleteTurn = { reply: deleted.result.reply, calls: deleted.calls.map(call => call.alias),
      prepared: deleted.view?.action ?? null, elapsedMs: deleted.elapsedMs }
    if (!deleted.view || deleted.view.action !== 'confirm_item_delete') throw new Error('MODEL_DID_NOT_PREPARE_DELETE')
    const stillThere = items.list().length
    const confirmed = await actions.resolve(1, { ticket: deleted.view.ticket, decision: 'delete', reminderDisposition: 'keep' })
    report.deleteResult = { stillThereBeforeConfirmation: stillThere === 1, itemId: confirmed.itemId,
      deleted: items.list().length === 0, receipt: Boolean(db.prepare('SELECT 1 FROM receipts WHERE action_id = ?').get(deleted.view.ticket)) }
    // 2) Real M01 asks to export another synthetic Item; the model prepares an export UI action.
    const artifactTarget = items.create({ actionId: 'synthetic-export', kind: 'note', title: '合成导出记录', body: '导出正文内容' }).item
    log({ stage: 'export_turn_start' })
    const exported = await turn('把「合成导出记录」导出成 Markdown 文件。')
    report.exportTurn = { reply: exported.result.reply, calls: exported.calls.map(call => call.alias),
      prepared: exported.view?.action ?? null, elapsedMs: exported.elapsedMs }
    if (!exported.view || exported.view.action !== 'export') throw new Error('MODEL_DID_NOT_PREPARE_EXPORT')
    const written = await actions.resolve(1, { ticket: exported.view.ticket, decision: 'export' })
    report.exportResult = { cancelled: written.cancelled, path: Boolean(written.path),
      bytes: written.path ? readFileSync(written.path).length : 0,
      containsBody: written.path ? readFileSync(written.path, 'utf8').includes('导出正文内容') : false }
    rmSync(directory, { recursive: true, force: true })
    tasks.close(); db.close()
    finish('passed', { assetReleaseId: assets.releaseId })
} catch (error) {
  finish('failed', { code: error?.code ?? error?.message ?? String(error) })
}
