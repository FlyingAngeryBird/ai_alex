// Production main-process integration; native file dialogs are fixture ports.
// No renderer evaluation, microphone, model request or copied user content.
import { app, ipcMain, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { CREDENTIAL_FIELDS } from '../../dist-electron/main/r1/credentials.js'
import { openR1Database } from '../../dist-electron/main/r1/database.js'
import { R1Items } from '../../dist-electron/main/r1/items.js'
import { R1Conversations } from '../../dist-electron/main/r1/conversations.js'
import { R1MemoryStore } from '../../dist-electron/main/r1/memory.js'
const root = process.env.SEAMO_R1_DATA_RESTART_ROOT, project = resolve(import.meta.dirname, '../..')
if (!root?.includes('seamo-r1-data-restart-')) throw new Error('ISOLATED_TEST_DIRECTORY_REQUIRED')
for (const directory of [root, project, dirname(project)]) if (existsSync(join(directory, '.env'))) throw new Error('NO_ENV_FILES_ALLOWED')
for (const field of CREDENTIAL_FIELDS) delete process.env[field]
const userData = join(root, 'app-data', 'Seamo AI R1'), stagePath = join(root, 'stage.json'), resultPath = join(root, 'result.json')
mkdirSync(userData, { recursive: true }); mkdirSync(join(root, 'chromium'), { recursive: true })
app.setPath('appData', join(root, 'app-data')); app.setPath('userData', userData); app.setPath('sessionData', join(root, 'chromium'))
const handlers = new Map(), originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => { handlers.set(channel, handler); originalHandle(channel, handler) }
dialog.showSaveDialog = async () => ({ canceled: false, filePath: join(root, 'backup.sqlite') })
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [join(root, 'backup.sqlite')] })
let ran = false
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    if (ran) return; ran = true
    void (async () => {
      const event = { sender: window.webContents }
      const call = async (channel, input) => { const result = await handlers.get(channel)(event, input); assert.equal(result.ok, true); return result.data }
      if (!existsSync(stagePath)) {
        const db = openR1Database(join(userData, 'r1.sqlite'))
        try {
          const items = new R1Items(db), conversations = new R1Conversations(db), memories = new R1MemoryStore(db)
          items.create({ actionId: 'restart-note1', kind: 'note', title: '合成恢复测试', body: '第一版', sourceRefs: [] })
          const sessionId = conversations.start()
          const source = conversations.append({ sessionId, turnId: 'restart-source', role: 'user', body: '记住，合成测试偏好为绿茶。', status: 'final' })
          const memory = memories.remember({ content: '合成测试偏好为绿茶', category: 'preference', sourceMessageIds: [source.messageId] })
          await call('r1.data.exportBackup')
          memories.forget(memory.memoryId, memory.version)
          items.create({ actionId: 'restart-note2', kind: 'note', title: '仅在覆盖前存在', body: '第二版', sourceRefs: [] })
        } finally { db.close() }
        const current = await call('r1.preferences.get')
        await call('r1.preferences.update', { expectedVersion: current.version, doNotDisturb: true })
        const { preview } = await call('r1.data.prepareRestore')
        assert.equal(preview.current.items, 2); assert.equal(preview.incoming.items, 1)
        assert.equal(preview.current.memories, 0); assert.equal(preview.incoming.memories, 1)
        writeFileSync(stagePath, JSON.stringify({ phase: 'confirming', previewCounts: { current: preview.current, incoming: preview.incoming } }), { mode: 0o600 })
        const accepted = await call('r1.data.confirmRestore', { ticket: preview.ticket, confirmed: true })
        assert.equal(accepted.restartRequired, true)
        console.log(JSON.stringify({ phase: 'production-restore-confirmed', pid: process.pid }))
      } else {
        const summary = await call('r1.data.summary'), preferences = await call('r1.preferences.get')
        assert.equal(summary.lastRestore?.status, 'succeeded'); assert.equal(summary.lastRestore.rollbackAvailable, true)
        assert.equal(summary.counts.items, 1); assert.equal(summary.counts.memories, 0); assert.equal(preferences.doNotDisturb, true)
        const result = { scope: 'production_main_restart_with_fixture_file_dialogs', passed: true, servicesConfigured: false, microphoneUsed: false,
          actualRelaunch: true, counts: summary.counts, restore: summary.lastRestore, doNotDisturbPreserved: true, forgottenMemoryRevived: false }
        app.once('will-quit', () => writeFileSync(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 }))
        console.log(JSON.stringify({ phase: 'production-relaunch-verified', pid: process.pid })); app.quit()
      }
    })().catch(error => {
      writeFileSync(resultPath, JSON.stringify({ passed: false, code: error?.code ?? 'PRODUCTION_RESTART_CHECK_FAILED' }), { mode: 0o600 })
      app.exit(1)
    })
  })
})
await import(pathToFileURL(join(project, 'dist-electron/main/index.js')).href)
