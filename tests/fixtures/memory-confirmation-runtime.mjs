// Real chat/confirmation IPC with synthetic model calls and an isolated disposable database.
import { app, BrowserWindow } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { openR1Database } from '../../dist-electron/main/r1/database.js'
import { R1Conversations } from '../../dist-electron/main/r1/conversations.js'
import { R1MemoryStore } from '../../dist-electron/main/r1/memory.js'
import { R1MemoryConfirmations } from '../../dist-electron/main/r1/memoryConfirmations.js'
import { R1PersonaStore } from '../../dist-electron/main/r1/persona.js'
import { R1TaskSupervisor } from '../../dist-electron/main/r1/taskSupervisor.js'
import { R1ConversationDriver } from '../../dist-electron/main/r1/conversationDriver.js'
import { loadR1PromptAssets } from '../../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../../dist-electron/main/providers/arkResponsesProvider.js'
import { registerR1Handlers } from '../../dist-electron/main/ipc/r1Handlers.js'
import { registerChatHandlers } from '../../dist-electron/main/ipc/chatHandlers.js'
import { registerMemoryConfirmationHandlers } from '../../dist-electron/main/ipc/memoryConfirmationHandlers.js'
const directory = mkdtempSync(join(tmpdir(), 'seamo-memory-confirmation-runtime-'))
app.setName('Seamo Memory Confirmation Check'); app.setPath('userData', directory)
let db, tasks, testWindow
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { tasks?.close(); db?.close(); rmSync(directory, { recursive: true, force: true }) })
void app.whenReady().then(async () => {
  db = openR1Database(join(directory, 'test.sqlite'))
  const memory = new R1MemoryStore(db), conversations = new R1Conversations(db), persona = new R1PersonaStore(db), assets = loadR1PromptAssets(resolve('r1-assets'))
  const mode = { temporary: false, sessionId: null }
  tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch())
  const manager = new R1MemoryConfirmations(db, { notify(owner, value) { if (testWindow?.webContents.id === owner) testWindow.webContents.send('r1.memoryConfirmation', value) }, onInvalidated() {}, onTemporaryExited() {} })
  const model = createArkResponsesProvider({ env: { VOLCENGINE_ARK_API_KEY: 'synthetic', VOLCENGINE_ARK_MODEL: 'synthetic' }, fetch: async (_url, init) => {
    const text = JSON.parse(String(init.body)).input.filter(item => item.role === 'user').at(-1).content
    return new Response(JSON.stringify({ id: crypto.randomUUID(), status: 'completed', output: [{ type: 'function_call', call_id: crypto.randomUUID(),
      name: 'memory_remember', arguments: JSON.stringify({ content: text.includes('花生') ? '对花生过敏' : '喜欢无糖茶', category: text.includes('花生') ? 'profile' : 'preference', sourceRefs: [] }) }] }))
  } })
  const driver = new R1ConversationDriver(db, assets, tasks, model, () => persona.get(), [])
  registerChatHandlers(undefined, undefined, undefined, conversations, persona, assets, memory, mode,
    (id, temporary) => { manager.revokeAll(); if (temporary) tasks.endTemporary(id) }, driver, undefined, manager)
  registerR1Handlers(db, undefined, mode)
  registerMemoryConfirmationHandlers(manager)
  testWindow = new BrowserWindow({ width: 1000, height: 760, title: 'Seamo Memory Confirmation Check',
    webPreferences: { preload: resolve('dist-electron/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } })
  await testWindow.loadURL('http://127.0.0.1:59541/tests/fixtures/memory-confirmation-runtime.html')
}).catch(error => { console.error(error); app.quit() })
