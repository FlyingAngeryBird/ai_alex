// Synthetic model, production Topic/summary/chat IPC, disposable ordinary conversation data.
import { app, BrowserWindow } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { openR1Database } from '../../dist-electron/main/r1/database.js'
import { R1Conversations } from '../../dist-electron/main/r1/conversations.js'
import { R1MemoryStore } from '../../dist-electron/main/r1/memory.js'
import { R1MemoryPolicy } from '../../dist-electron/main/r1/memoryPolicy.js'
import { R1Topics } from '../../dist-electron/main/r1/topics.js'
import { R1TopicSummaries } from '../../dist-electron/main/r1/topicSummaries.js'
import { R1AutomaticMemory } from '../../dist-electron/main/r1/automaticMemory.js'
import { R1PersonaStore } from '../../dist-electron/main/r1/persona.js'
import { R1TaskSupervisor } from '../../dist-electron/main/r1/taskSupervisor.js'
import { R1ConversationDriver } from '../../dist-electron/main/r1/conversationDriver.js'
import { loadR1PromptAssets } from '../../dist-electron/main/r1/promptAssets.js'
import { createArkResponsesProvider } from '../../dist-electron/main/providers/arkResponsesProvider.js'
import { registerR1Handlers } from '../../dist-electron/main/ipc/r1Handlers.js'
import { registerChatHandlers } from '../../dist-electron/main/ipc/chatHandlers.js'
import { registerTopicHandlers } from '../../dist-electron/main/ipc/topicHandlers.js'
import { registerAutomaticMemoryHandlers } from '../../dist-electron/main/ipc/automaticMemoryHandlers.js'
const directory = mkdtempSync(join(tmpdir(), 'seamo-topics-runtime-'))
app.commandLine.appendSwitch('force-renderer-accessibility')
app.setName('Seamo Topics Check'); app.setPath('userData', directory)
let db, tasks, summaries, automatic, testWindow
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { summaries?.close(); automatic?.close(); tasks?.close(); db?.close(); rmSync(directory, { recursive: true, force: true }) })
void app.whenReady().then(async () => {
  db = openR1Database(join(directory, 'test.sqlite'))
  const conversations = new R1Conversations(db), memory = new R1MemoryStore(db), persona = new R1PersonaStore(db), topics = new R1Topics(db), assets = loadR1PromptAssets(resolve('r1-assets'))
  const mode = { temporary: false, sessionId: null }, changed = () => testWindow?.webContents.send('r1.memoryChanged', {})
  const invalidate = () => { summaries.invalidate(); if (mode.selectedTopic) { try { mode.selectedTopic.version = topics.get(mode.selectedTopic.topicId).version } catch { mode.selectedTopic = null } }; changed() }
  const model = createArkResponsesProvider({ env: { VOLCENGINE_ARK_API_KEY: 'synthetic', VOLCENGINE_ARK_MODEL: 'synthetic' }, fetch: async (_url, init) => {
    const request = JSON.parse(String(init.body)); let text = '好的，这些条件已说明。'
    if (request.text?.format?.name === 'context_summary') {
      const source = JSON.parse(request.input.at(-1).content).filter(row => row.role === 'user').at(-1), prior = topics.list().entries[0]
      text = JSON.stringify({ summary: '先完成中文 macOS 内部版，暂不做移动版。发布日期仍未确定。', sourceTurnIds: [source.turnId], memoryIds: [], taskFacts: [],
        topic: { topicId: prior?.topicId ?? null, expectedVersion: prior?.version ?? null, title: '桌面版开发计划', unresolved: ['发布日期待确定'], status: 'active' } })
    } else {
      const marker = request.instructions.lastIndexOf('APP_CONTEXT_DATA\n'), context = JSON.parse(request.instructions.slice(marker + 'APP_CONTEXT_DATA\n'.length))
      if (context.selectedEntity?.type === 'topic') text = `当前话题 v${context.topics[0].version}：${context.topics[0].summary}`
    }
    return new Response(JSON.stringify({ id: crypto.randomUUID(), status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] }))
  } })
  summaries = new R1TopicSummaries(db, assets, conversations, model, { personaVersion: () => persona.get().version, configurationRevision: () => 1, onChanged: changed, onInvalidated: invalidate })
  automatic = new R1AutomaticMemory(db, assets, conversations, model, { persona: () => persona.get(), configurationRevision: () => 1, onInvalidated: invalidate, onSaved: changed })
  registerAutomaticMemoryHandlers(automatic, () => summaries.invalidate())
  new R1MemoryPolicy(db).update({ enabled: true, expectedVersion: 1 })
  tasks = new R1TaskSupervisor(db, assets, () => memory.currentDeletionEpoch())
  const driver = new R1ConversationDriver(db, assets, tasks, model, () => persona.get(), [])
  registerChatHandlers(undefined, undefined, undefined, conversations, persona, assets, memory, mode,
    (id, temporary) => { summaries.invalidate(); if (temporary) tasks.endTemporary(id) }, driver, invalidate, undefined, undefined, summaries)
  registerR1Handlers(db, undefined, mode, invalidate)
  registerTopicHandlers(db, mode, invalidate, () => summaries.getState(), () => {})
  testWindow = new BrowserWindow({ width: 1280, height: 820, title: 'Seamo Topics Check', webPreferences: {
    preload: resolve('dist-electron/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } })
  await testWindow.loadURL('http://127.0.0.1:59541/tests/fixtures/topics-runtime.html')
}).catch(error => { console.error(error); app.quit() })
