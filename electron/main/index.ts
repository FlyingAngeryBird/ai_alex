import { createPageReader } from './providers/pageReader.js'
import { createBraveSearchProvider } from './providers/braveSearchProvider.js'
import { registerNativeVoiceHandlers } from './ipc/nativeVoiceHandlers.js'
import { app, BrowserWindow, powerMonitor } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { loadEnvironmentFiles, resolveEnvironmentCandidateDirectories } from './env.js'
import { getDefaultConfigStore, initDefaultConfigStore } from './config/configStore.js'
import { getDefaultMusicStore, initDefaultMusicStore } from './music/musicStore.js'
import { registerAppHandlers } from './ipc/appHandlers.js'
import { registerChatHandlers } from './ipc/chatHandlers.js'
import { registerConfigHandlers } from './ipc/configHandlers.js'
import { registerMusicHandlers } from './ipc/musicHandlers.js'
import { registerTtsHandlers } from './ipc/ttsHandlers.js'
import { registerVoiceHandlers } from './ipc/voiceHandlers.js'
import { createMainWindowOptions } from './windowOptions.js'
import { importLegacyJson, openR1Database, type R1Database } from './r1/database.js'
import { registerR1Handlers } from './ipc/r1Handlers.js'
import { registerCredentialHandlers } from './ipc/credentialHandlers.js'
import { registerSearchHandlers } from './ipc/searchHandlers.js'
import { CredentialVault } from './r1/credentials.js'
import { createElectronReminderScheduler, type ReminderScheduler } from './r1/reminderScheduler.js'
import { R1Conversations } from './r1/conversations.js'
import { R1PersonaStore } from './r1/persona.js'
import { R1MemoryStore } from './r1/memory.js'
import { loadR1PromptAssets, type R1PromptAssets } from './r1/promptAssets.js'
import type { MusicTrack } from './music/gdstudioMusicProvider.js'
import type { R1SessionMode } from './r1/sessionMode.js'
import { R1Focus } from './r1/focus.js'
import { registerFocusHandlers } from './ipc/focusHandlers.js'
import { R1ServiceDiagnostics } from './r1/serviceDiagnostics.js'
import { registerServiceHandlers } from './ipc/serviceHandlers.js'
import { R1TaskSupervisor } from './r1/taskSupervisor.js'
import { R1Artifacts } from './r1/artifacts.js'
import { registerTaskHandlers } from './ipc/taskHandlers.js'
import { R1TaskToolExecutor } from './r1/taskToolExecutor.js'
import { R1TaskRunner } from './r1/taskRunner.js'
import { R1Items } from './r1/items.js'
import { createArkResponsesProvider } from './providers/arkResponsesProvider.js'
import { R1ConversationDriver } from './r1/conversationDriver.js'
import { R1MemoryConfirmations } from './r1/memoryConfirmations.js'
import { registerMemoryConfirmationHandlers } from './ipc/memoryConfirmationHandlers.js'
import { R1AutomaticMemory } from './r1/automaticMemory.js'
import { registerAutomaticMemoryHandlers } from './ipc/automaticMemoryHandlers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
let nativeVoice: { close(): void } | null = null
let r1Database: R1Database | null = null
let reminderScheduler: ReminderScheduler | null = null
let r1PromptAssets: R1PromptAssets | null = null
let r1Focus: R1Focus | null = null
let r1Diagnostics: R1ServiceDiagnostics | null = null
let r1Tasks: R1TaskSupervisor | null = null
let r1TaskRunner: R1TaskRunner | null = null
let r1ConversationDriver: R1ConversationDriver | null = null
let r1Artifacts: R1Artifacts | null = null
let r1Conversations: R1Conversations | null = null
let memoryConfirmations: R1MemoryConfirmations | null = null
let automaticMemory: R1AutomaticMemory | null = null
const r1SessionMode: R1SessionMode = { temporary: false }
function invalidateMemoryContexts(deletionEpoch: number): void {
  automaticMemory?.invalidate()
  memoryConfirmations?.revokeAll()
  nativeVoice?.close()
  r1Tasks?.invalidateContext()
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.memoryInvalidated', { deletionEpoch })
}

// R1 keeps its data separate from every legacy lingmo build. The old directory
// is only read by the explicit migration path; opening R1 never writes to it.
app.setName('Seamo AI R1')
app.setPath('userData', join(app.getPath('appData'), 'Seamo AI R1'))
const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0]
  if (window?.isMinimized()) window.restore()
  window?.show()
  window?.focus()
})

loadEnvironmentFiles(
  resolveEnvironmentCandidateDirectories({
    appPath: app.getAppPath(),
    cwd: process.cwd(),
    mainDir: __dirname,
    userDataPath: app.getPath('userData')
  })
)

initDefaultConfigStore(join(app.getPath('userData'), 'config.json'))
initDefaultMusicStore(join(app.getPath('userData'), 'music.json'))

function createMainWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow(
    createMainWindowOptions(join(__dirname, '../preload/index.js'))
  )

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

registerAppHandlers()
registerConfigHandlers()
registerMusicHandlers()
registerTtsHandlers()
registerVoiceHandlers()
registerSearchHandlers()

void app.whenReady().then(async () => {
  if (!ownsInstance) return
  try {
    r1Database = openR1Database(join(app.getPath('userData'), 'r1.sqlite'))
    r1PromptAssets = loadR1PromptAssets(join(app.getAppPath(), 'r1-assets'))
    r1Conversations = new R1Conversations(r1Database)
    const memory = new R1MemoryStore(r1Database)
    memoryConfirmations = new R1MemoryConfirmations(r1Database, {
      notify(ownerId, confirmation) {
        const owner = BrowserWindow.getAllWindows().find(window => window.webContents.id === ownerId)
        if (owner && !owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send('r1.memoryConfirmation', confirmation)
      },
      onInvalidated: invalidateMemoryContexts, onTemporaryExited: () => nativeVoice?.close()
    })
    registerMemoryConfirmationHandlers(memoryConfirmations)
    r1Artifacts = new R1Artifacts(r1Database)
    r1Tasks = new R1TaskSupervisor(r1Database, r1PromptAssets, () => memory.currentDeletionEpoch(), {
      temporarySource: messageId => {
        const sessionId = r1SessionMode.temporary && r1SessionMode.sessionId
        if (!sessionId || !r1Conversations?.isTemporary(sessionId)) return undefined
        const source = r1Conversations.messages(sessionId).find(message => message.messageId === messageId && message.role === 'user')
        return source ? { ...source, temporary: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : undefined
      }
    })
    registerTaskHandlers(r1Tasks, r1Artifacts, r1SessionMode)
    r1Tasks.onChanged(event => {
      if (!r1Tasks?.list(r1SessionMode.temporary ? r1SessionMode.sessionId || '__missing__' : null)
        .some(task => task.taskId === event.task.taskId)) return
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.taskChanged', event)
    })
    const vault = new CredentialVault(join(app.getPath('userData'), 'credentials.bin'))
    vault.load()
    automaticMemory = new R1AutomaticMemory(r1Database, r1PromptAssets, r1Conversations, createArkResponsesProvider(), {
      persona: () => new R1PersonaStore(r1Database!).get(), configurationRevision: () => vault.revision,
      onInvalidated: invalidateMemoryContexts,
      onSaved() { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.memoryChanged', {}) }
    })
    registerAutomaticMemoryHandlers(automaticMemory, () => memoryConfirmations?.revokeAutomatic())
    automaticMemory.onChanged(state => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.memoryPolicyChanged', { ...automaticMemory!.getPolicy(), ...state })
    })
    r1Focus = new R1Focus(r1Database)
    const focusServices = { focus: r1Focus, currentTrackKey: () => r1SessionMode.currentPlayingTrackKey ?? null }
    const taskTools = new R1TaskToolExecutor(r1Tasks, r1PromptAssets, new R1Items(r1Database), createBraveSearchProvider(), createPageReader(), focusServices)
    r1TaskRunner = new R1TaskRunner(r1Tasks, r1PromptAssets, taskTools, r1Artifacts,
      createArkResponsesProvider(), () => new R1PersonaStore(r1Database!).get())
    r1ConversationDriver = new R1ConversationDriver(r1Database, r1PromptAssets, r1Tasks, createArkResponsesProvider(),
      () => new R1PersonaStore(r1Database!).get(), taskTools.implementedAliases, focusServices)
    nativeVoice = registerNativeVoiceHandlers({ db: r1Database, assets: r1PromptAssets,
      persona: new R1PersonaStore(r1Database), memory, conversations: r1Conversations,
      tasks: r1Tasks, mode: r1SessionMode, implementedTaskAliases: taskTools.implementedAliases,
      configurationRevision: () => vault.revision, focusServices, onMemoryInvalidated: invalidateMemoryContexts,
      memoryConfirmations, automaticMemory })
    powerMonitor.on('suspend', () => { nativeVoice?.close(); automaticMemory?.invalidate(); memoryConfirmations?.revokeAutomatic() })
    r1TaskRunner.start()
    importLegacyJson(r1Database, join(app.getPath('appData'), 'lingli'), 'lingli-json')
    importLegacyJson(r1Database, join(app.getPath('appData'), 'lingmo'), 'lingmo-json')
    registerR1Handlers(r1Database, undefined, r1SessionMode, invalidateMemoryContexts)
    registerCredentialHandlers(vault)
    r1Diagnostics = new R1ServiceDiagnostics(vault, r1PromptAssets, new R1PersonaStore(r1Database))
    registerServiceHandlers(r1Diagnostics)
    registerFocusHandlers(r1Focus, undefined, r1SessionMode)
    r1Focus.onChanged(event => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.focusChanged', event)
    })
    powerMonitor.on('suspend', () => r1Focus?.suspend())
    powerMonitor.on('resume', () => r1Focus?.wake())
    powerMonitor.on('suspend', () => r1Tasks?.suspend())
    powerMonitor.on('resume', () => r1Tasks?.wake())
  } catch (error) {
    const { dialog } = await import('electron')
    dialog.showErrorBox(
      'Seamo AI R1 无法打开数据',
      error instanceof Error ? error.message : '数据迁移失败，请检查本地数据。'
    )
    app.quit()
    return
  }
  const userData = app.getPath('userData')
  const configPath = join(userData, 'config.json')
  const musicPath = join(userData, 'music.json')
  await getDefaultConfigStore().loadConfig()
  await getDefaultMusicStore().loadLibrary()
  if (r1Database) {
    registerChatHandlers(undefined, undefined, undefined, r1Conversations ?? undefined,
      new R1PersonaStore(r1Database), r1PromptAssets ?? undefined,
      new R1MemoryStore(r1Database), r1SessionMode, (sessionId, temporary) => {
        automaticMemory?.invalidate()
        memoryConfirmations?.revokeAll()
        if (temporary) { r1Tasks?.endTemporary(sessionId); r1Artifacts?.endTemporary(sessionId) }
      }, r1ConversationDriver ?? undefined, invalidateMemoryContexts, memoryConfirmations ?? undefined, automaticMemory ?? undefined)
  }
  if (r1Database && !existsSync(configPath)) {
    const persona = r1Database.prepare('SELECT voice_id FROM persona WHERE id = 1')
      .get() as { voice_id: string }
    if (persona.voice_id) {
      await getDefaultConfigStore().updateConfig({ voice: {
        voices: [{ id: persona.voice_id, name: '已导入音色' }],
        activeVoiceId: persona.voice_id
      } })
    }
  }
  if (r1Database && !existsSync(musicPath)) {
    const tracks = r1Database.prepare('SELECT track_json FROM music_favorites ORDER BY created_at')
      .all() as { track_json: string }[]
    for (const track of tracks) {
      await getDefaultMusicStore().toggleFavorite(JSON.parse(track.track_json) as MusicTrack)
    }
  }
  createMainWindow()
  r1Focus?.startScheduler()
  if (r1Database) {
    reminderScheduler = createElectronReminderScheduler(r1Database)
    reminderScheduler.start()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('before-quit', () => {
  automaticMemory?.close()
  nativeVoice?.close()
  r1Tasks?.close()
  void r1TaskRunner?.close()
  r1Diagnostics?.close()
  r1Focus?.close()
  reminderScheduler?.stop()
  r1Database?.close()
  r1Database = null
})

app.on('window-all-closed', () => {
  automaticMemory?.invalidate()
  memoryConfirmations?.revokeAll()
  r1SessionMode.currentPlayingTrackKey = null
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
