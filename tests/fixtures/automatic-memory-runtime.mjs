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
import { R1AutomaticMemory } from '../../dist-electron/main/r1/automaticMemory.js'
import { registerAutomaticMemoryHandlers } from '../../dist-electron/main/ipc/automaticMemoryHandlers.js'
import { CredentialVault } from '../../dist-electron/main/r1/credentials.js'
import { registerCredentialHandlers } from '../../dist-electron/main/ipc/credentialHandlers.js'
import { R1ConversationDriver } from '../../dist-electron/main/r1/conversationDriver.js'
import { loadR1PromptAssets } from '../../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../../dist-electron/main/providers/arkResponsesProvider.js'
import { registerR1Handlers } from '../../dist-electron/main/ipc/r1Handlers.js'
import { registerChatHandlers } from '../../dist-electron/main/ipc/chatHandlers.js'
import { registerMemoryConfirmationHandlers } from '../../dist-electron/main/ipc/memoryConfirmationHandlers.js'
const directory = mkdtempSync(join(tmpdir(), 'seamo-automatic-memory-runtime-'))
app.setName('Seamo Automatic Memory Check'); app.setPath('userData', directory)
let db, tasks, testWindow, automatic
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { automatic?.close(); tasks?.close(); db?.close(); rmSync(directory, { recursive: true, force: true }) })
void app.whenReady().then(async () => {
  db = openR1Database(join(directory, 'test.sqlite'))
  const memory = new R1MemoryStore(db), conversations = new R1Conversations(db), persona = new R1PersonaStore(db), assets = loadR1PromptAssets(resolve('r1-assets'))
  const mode = { temporary: false, sessionId: null }
  tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch())
  const manager = new R1MemoryConfirmations(db, { notify(owner, value) { if (testWindow?.webContents.id === owner) testWindow.webContents.send('r1.memoryConfirmation', value) }, onInvalidated() {}, onTemporaryExited() {} })
  const model = createArkResponsesProvider({ env: { VOLCENGINE_ARK_API_KEY: 'synthetic', VOLCENGINE_ARK_MODEL: 'synthetic' }, fetch: async (_url, init) => {
    const request = JSON.parse(String(init.body))
    let text = '好的，我们继续聊。'
    if (request.text?.format?.name === 'memory_candidates') {
      const source = JSON.parse(request.input.at(-1).content).at(-1)
      text = JSON.stringify(source.text.includes('偏头痛') ? { candidates: [], sensitiveSourceTurnIds: [source.turnId] } :
        { candidates: [{ content: '喜欢无糖茶', category: 'preference', sourceTurnIds: [source.turnId], validUntil: null, supersedesMemoryIds: [] }], sensitiveSourceTurnIds: [] })
    }
    return new Response(JSON.stringify({ id: crypto.randomUUID(), status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }))
  } })
  automatic = new R1AutomaticMemory(db, assets, conversations, model, { persona: () => persona.get(), configurationRevision: () => 1, onInvalidated() {},
    onSaved() { testWindow?.webContents.send('r1.memoryChanged', {}) } })
  registerAutomaticMemoryHandlers(automatic, () => manager.revokeAutomatic())
  automatic.onChanged(state => testWindow?.webContents.send('r1.memoryPolicyChanged', { ...automatic.getPolicy(), ...state }))
  registerCredentialHandlers(new CredentialVault(join(directory, 'credentials.bin')))
  const driver = new R1ConversationDriver(db, assets, tasks, model, () => persona.get(), [])
  registerChatHandlers(undefined, undefined, undefined, conversations, persona, assets, memory, mode,
    (id, temporary) => { automatic.invalidate(); manager.revokeAll(); if (temporary) tasks.endTemporary(id) }, driver, undefined, manager, automatic)
  registerR1Handlers(db, undefined, mode)
  registerMemoryConfirmationHandlers(manager)
  testWindow = new BrowserWindow({ width: 1000, height: 760, title: 'Seamo Automatic Memory Check',
    webPreferences: { preload: resolve('dist-electron/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } })
  await testWindow.loadURL('http://127.0.0.1:59541/tests/fixtures/automatic-memory-runtime.html')
}).catch(error => { console.error(error); app.quit() })
