import { createPageReader } from './providers/pageReader.js'
import { createDoubaoSearchProvider } from './providers/doubaoSearchProvider.js'
import { registerNativeVoiceHandlers } from './ipc/nativeVoiceHandlers.js'
import { createNativeSearchHintCache } from './providers/nativeSearchHint.js'
import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from 'electron'
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
import { registerItemActionHandlers } from './ipc/itemActionHandlers.js'
import { R1ItemActions } from './r1/itemActions.js'
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
import { R1TaskDelivery } from './r1/taskDelivery.js'
import { R1ReminderDelivery } from './r1/reminderDelivery.js'
import { registerReminderDeliveryHandlers } from './ipc/reminderDeliveryHandlers.js'
import { registerTaskDeliveryHandlers } from './ipc/taskDeliveryHandlers.js'
import { synthesizeNativeAnnouncement } from './providers/nativeAnnouncement.js'
import { R1Artifacts } from './r1/artifacts.js'
import { registerTaskHandlers } from './ipc/taskHandlers.js'
import { R1TaskToolExecutor } from './r1/taskToolExecutor.js'
import { R1TaskRunner } from './r1/taskRunner.js'
import { R1Items } from './r1/items.js'
import { createArkResponsesProvider } from './providers/arkResponsesProvider.js'
import { R1ConversationDriver } from './r1/conversationDriver.js'
import { R1MemoryConfirmations } from './r1/memoryConfirmations.js'
import { registerMemoryConfirmationHandlers } from './ipc/memoryConfirmationHandlers.js'
import { R1TopicSummaries } from './r1/topicSummaries.js'
import { R1Topics } from './r1/topics.js'
import { registerTopicHandlers } from './ipc/topicHandlers.js'
import { R1AutomaticMemory } from './r1/automaticMemory.js'
import { registerAutomaticMemoryHandlers } from './ipc/automaticMemoryHandlers.js'
import { registerArtifactContextHandlers } from './ipc/artifactContextHandlers.js'
import { R1Music } from './r1/music.js'
import { R1Preferences } from './r1/preferences.js'
import { registerPreferencesHandlers } from './ipc/preferencesHandlers.js'
import { R1DataManagement } from './r1/dataManagement.js'
import { registerDataHandlers } from './ipc/dataHandlers.js'
import { R1Onboarding } from './r1/onboarding.js'
import { registerOnboardingHandlers } from './ipc/onboardingHandlers.js'
import { registerR1MusicHandlers } from './ipc/musicR1Handlers.js'
import { createConfiguredMusicProvider } from './ipc/musicHandlers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
let nativeVoice: { close(code?: string): void } | null = null
let r1Database: R1Database | null = null
let reminderScheduler: ReminderScheduler | null = null
let r1PromptAssets: R1PromptAssets | null = null
let r1Focus: R1Focus | null = null
let r1Diagnostics: R1ServiceDiagnostics | null = null
let r1Tasks: R1TaskSupervisor | null = null
let taskDelivery: R1TaskDelivery | null = null
let reminderDelivery: R1ReminderDelivery | null = null
let r1TaskRunner: R1TaskRunner | null = null
let r1ConversationDriver: R1ConversationDriver | null = null
let r1Artifacts: R1Artifacts | null = null
let r1Music: R1Music | null = null
let chatController: { close(): void } | null = null
let r1Conversations: R1Conversations | null = null
let memoryConfirmations: R1MemoryConfirmations | null = null
let itemActions: R1ItemActions | null = null
let topicSummaries: R1TopicSummaries | null = null
let automaticMemory: R1AutomaticMemory | null = null
let dataManagement: R1DataManagement | null = null
const r1SessionMode: R1SessionMode = { temporary: false }
function invalidateMemoryContexts(deletionEpoch: number): void {
  reminderDelivery?.invalidate()
  taskDelivery?.invalidate()
  topicSummaries?.invalidate()
  r1SessionMode.selectedArtifact = null
  if (r1SessionMode.selectedTopic && r1Database) {
    try { const current = new R1Topics(r1Database).get(r1SessionMode.selectedTopic.topicId); r1SessionMode.selectedTopic.version = current.version }
    catch { r1SessionMode.selectedTopic = null }
  }
  automaticMemory?.invalidate()
  memoryConfirmations?.revokeAll()
  nativeVoice?.close('MEMORY_CONTEXT_REFRESH_REQUIRED')
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
  const ownerId = mainWindow.webContents.id
  mainWindow.webContents.once('destroyed', () => { itemActions?.revokeOwner(ownerId) })

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
    const preferences = new R1Preferences(r1Database)
    registerOnboardingHandlers(new R1Onboarding(join(app.getPath('userData'), 'onboarding.json')))
    registerPreferencesHandlers(preferences)
    importLegacyJson(r1Database, join(app.getPath('appData'), 'lingli'), 'lingli-json')
    importLegacyJson(r1Database, join(app.getPath('appData'), 'lingmo'), 'lingmo-json')
    const legacyMusic = await getDefaultMusicStore().loadLibrary()
    const musicPolicy = r1PromptAssets.musicPolicy()
    r1Music = new R1Music(r1Database, createConfiguredMusicProvider({ timeoutMs: musicPolicy.deviceTimeoutMs }),
      { legacy: legacyMusic, timeoutMs: musicPolicy.deviceTimeoutMs, resourceAttempts: musicPolicy.resourceAttempts })
    registerR1MusicHandlers(r1Database, r1Music, r1PromptAssets, r1SessionMode)
    r1Music.onChanged(snapshot => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.musicChanged', snapshot) })
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
      artifacts: r1Artifacts,
      temporarySource: messageId => {
        const sessionId = r1SessionMode.temporary && r1SessionMode.sessionId
        if (!sessionId || !r1Conversations?.isTemporary(sessionId)) return undefined
        const source = r1Conversations.messages(sessionId).find(message => message.messageId === messageId && message.role === 'user')
        return source ? { ...source, temporary: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : undefined
      }
    })
    const artifactChanged = (artifact: { artifactId: string; version: number }) => {
      if (r1SessionMode.selectedArtifact?.artifactId === artifact.artifactId && r1SessionMode.selectedArtifact.version !== artifact.version) {
        r1SessionMode.selectedArtifact = { artifactId: artifact.artifactId, version: artifact.version, selection: null }
        nativeVoice?.close('REALTIME_CONTEXT_REFRESH_REQUIRED')
      }
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.artifactChanged', { artifactId: artifact.artifactId, version: artifact.version })
    }
    registerTaskHandlers(r1Tasks, r1Artifacts, r1SessionMode, undefined, artifactChanged)
    registerArtifactContextHandlers(r1Database, r1Artifacts, r1Conversations, r1SessionMode, () => nativeVoice?.close('REALTIME_CONTEXT_REFRESH_REQUIRED'))
    r1Tasks.onChanged(event => {
      if (!r1Tasks?.list(r1SessionMode.temporary ? r1SessionMode.sessionId || '__missing__' : null)
        .some(task => task.taskId === event.task.taskId)) return
      taskDelivery?.observe(event)
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.taskChanged', event)
      if (event.reason === 'completed') for (const artifact of event.task.result?.artifacts ?? []) artifactChanged(artifact)
    })
    const vault = new CredentialVault(join(app.getPath('userData'), 'credentials.bin'))
    try { vault.load() } catch {
      // Keep local pages usable. The vault retains its failure state, blocks saves
      // that could overwrite unreadable secrets, and can retry through settings.
    }
    taskDelivery = new R1TaskDelivery({ assets: r1PromptAssets, tasks: r1Tasks, conversations: r1Conversations,
      provider: createArkResponsesProvider({ timeoutMs: 12000, thinking: 'disabled' }), persona: () => new R1PersonaStore(r1Database!).get(),
      preferences: () => preferences.get(), scope: () => ({ temporary: r1SessionMode.temporary, sessionId: r1SessionMode.sessionId }),
      configurationRevision: () => vault.revision, synthesize: synthesizeNativeAnnouncement })
    registerTaskDeliveryHandlers(taskDelivery, ipcMain)
    reminderDelivery = new R1ReminderDelivery({ db: r1Database, assets: r1PromptAssets, conversations: r1Conversations,
      scope: () => ({ ...r1SessionMode }), preferences: () => preferences.get(), persona: () => new R1PersonaStore(r1Database!).get(),
      configurationRevision: () => vault.revision, provider: createArkResponsesProvider({ timeoutMs: 12000, thinking: 'disabled' }),
      synthesize: synthesizeNativeAnnouncement })
    registerReminderDeliveryHandlers(reminderDelivery, ipcMain)
    preferences.onChanged(() => { taskDelivery?.invalidate(); reminderDelivery?.invalidate() })
    automaticMemory = new R1AutomaticMemory(r1Database, r1PromptAssets, r1Conversations, createArkResponsesProvider(), {
      persona: () => new R1PersonaStore(r1Database!).get(), configurationRevision: () => vault.revision,
      onInvalidated: invalidateMemoryContexts,
      onSaved() { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.memoryChanged', {}) }
    })
    topicSummaries = new R1TopicSummaries(r1Database, r1PromptAssets, r1Conversations, createArkResponsesProvider({ timeoutMs: r1PromptAssets.summaryWindow().requestTimeoutMs }), {
      personaVersion: () => new R1PersonaStore(r1Database!).get().version, configurationRevision: () => vault.revision,
      onInvalidated: invalidateMemoryContexts,
      onChanged() { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.memoryChanged', {}) }
    })
    registerTopicHandlers(r1Database, r1SessionMode, invalidateMemoryContexts, () => topicSummaries!.getState(), () => nativeVoice?.close())
    registerAutomaticMemoryHandlers(automaticMemory, () => { topicSummaries?.invalidate(); memoryConfirmations?.revokeAutomatic() })
    automaticMemory.onChanged(state => {
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.memoryPolicyChanged', { ...automaticMemory!.getPolicy(), ...state })
    })
    r1Focus = new R1Focus(r1Database)
    const focusServices = { focus: r1Focus, currentTrackKey: () => r1SessionMode.currentPlayingTrackKey ?? null }
    itemActions = new R1ItemActions(r1Database, new R1Items(r1Database), r1Artifacts, {
      notify(owner, view) {
        const target = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.id === owner)
        if (target && !target.webContents.isDestroyed()) target.webContents.send('r1.itemAction', view)
      },
      choose: async (name, extension) => {
        const selected = await dialog.showSaveDialog({ defaultPath: name,
          filters: [{ name: extension === 'md' ? 'Markdown' : '纯文本', extensions: [extension] }] })
        return selected.canceled ? null : selected.filePath ?? null
      },
      isSessionCurrent: context => context.temporary
        ? r1SessionMode.temporary === true && r1SessionMode.sessionId === context.sessionId
        : r1SessionMode.temporary !== true,
      isOwnerAlive: ownerId => BrowserWindow.getAllWindows().some(window =>
        !window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.id === ownerId),
      onTaskReceipt(taskId) { try { r1Tasks?.refreshExternalReceipts(taskId) } catch { /* receipt already persisted */ } },
      onTaskActionSettled(taskId, actionId, outcome, detail) {
        try { r1Tasks?.settlePendingUiAction(taskId, actionId, outcome, detail) } catch { /* terminal state stays in the receipt */ }
      },
      isTaskCurrent: task => {
        try { const current = r1Tasks!.get(task.taskId)
          return current.goalVersion === task.goalVersion && !['cancelled', 'failed'].includes(current.status)
        } catch { return false }
      },
      onChanged(change) { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.itemsChanged', change) }
    })
    r1Tasks.bindPendingInvalidator((_taskId, actionIds, reason) => { itemActions?.revokePending(actionIds, reason) })
    const itemActionSweep = setInterval(() => { itemActions?.sweep() }, 30_000)
    itemActionSweep.unref?.()
    registerItemActionHandlers(itemActions)
    const taskTools = new R1TaskToolExecutor(r1Tasks, r1PromptAssets, new R1Items(r1Database), createDoubaoSearchProvider(), createPageReader(), focusServices, r1Music, itemActions)
    r1TaskRunner = new R1TaskRunner(r1Tasks, r1PromptAssets, taskTools, r1Artifacts,
      createArkResponsesProvider({ timeoutMs: 60_000 }), () => new R1PersonaStore(r1Database!).get())
    r1ConversationDriver = new R1ConversationDriver(r1Database, r1PromptAssets, r1Tasks, createArkResponsesProvider({ timeoutMs: 30_000 }),
      () => new R1PersonaStore(r1Database!).get(), taskTools.implementedAliases, focusServices, r1Artifacts, r1Music)
    nativeVoice = registerNativeVoiceHandlers({ db: r1Database, assets: r1PromptAssets,
      persona: new R1PersonaStore(r1Database), memory, conversations: r1Conversations,
      tasks: r1Tasks, mode: r1SessionMode, implementedTaskAliases: taskTools.implementedAliases,
      search: createDoubaoSearchProvider({ resultLimit: r1PromptAssets.realtimeSearchPolicy().candidates, timeoutMs: r1PromptAssets.realtimeSearchPolicy().timeoutMs }), pages: createPageReader(),
      searchHint: createNativeSearchHintCache(),
      configurationRevision: () => vault.revision, focusServices, onMemoryInvalidated: invalidateMemoryContexts,
      memoryConfirmations, automaticMemory, topicSummaries, artifacts: r1Artifacts, music: r1Music, itemActions })
    powerMonitor.on('suspend', () => { taskDelivery?.invalidate(); reminderDelivery?.invalidate(); nativeVoice?.close(); automaticMemory?.invalidate(); topicSummaries?.invalidate(); memoryConfirmations?.revokeAutomatic() })
    r1TaskRunner.start()
    registerR1Handlers(r1Database, undefined, r1SessionMode, invalidateMemoryContexts)
    registerCredentialHandlers(vault)
    r1Diagnostics = new R1ServiceDiagnostics(vault, r1PromptAssets, new R1PersonaStore(r1Database))
    registerServiceHandlers(r1Diagnostics)
    dataManagement = new R1DataManagement(r1Database, join(app.getPath('userData'), 'r1.sqlite'), app.getPath('userData'))
    registerDataHandlers(dataManagement, r1Database, { vault, assetRelease: r1PromptAssets.releaseId, diagnostics: () => r1Diagnostics,
      requestRestart: () => { setTimeout(() => app.quit(), 0) } })
    registerFocusHandlers(r1Focus, undefined, r1SessionMode)
    r1Focus.onChanged(event => {
      const deliveryId = reminderDelivery?.observeFocus(event)
      if (deliveryId) event = { ...event, deliveryId }
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.focusChanged', event)
    })
    powerMonitor.on('suspend', () => r1Focus?.suspend())
    powerMonitor.on('resume', () => r1Focus?.wake())
    powerMonitor.on('resume', () => reminderScheduler?.recoverMissed())
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
    chatController = registerChatHandlers(undefined, undefined, undefined, r1Conversations ?? undefined,
      new R1PersonaStore(r1Database), r1PromptAssets ?? undefined,
      new R1MemoryStore(r1Database), r1SessionMode, (sessionId, temporary) => {
        automaticMemory?.invalidate(); topicSummaries?.invalidate()
        memoryConfirmations?.revokeAll(); itemActions?.revokeAll()
        if (temporary) { r1Tasks?.endTemporary(sessionId); r1Artifacts?.endTemporary(sessionId) }
      }, r1ConversationDriver ?? undefined, invalidateMemoryContexts, memoryConfirmations ?? undefined, automaticMemory ?? undefined, topicSummaries ?? undefined, itemActions ?? undefined)
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
    reminderScheduler = createElectronReminderScheduler(r1Database, event => reminderDelivery?.observeReminder(event) ?? null)
    reminderScheduler.start()
  }

  app.on('activate', () => {
    if (!shutdownStarted && BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

let shutdownStarted = false, shutdownFinished = false
app.on('before-quit', event => {
  if (shutdownFinished) return
  event.preventDefault()
  if (shutdownStarted) return
  shutdownStarted = true
  taskDelivery?.invalidate()
  reminderDelivery?.invalidate()
  dataManagement?.close()
  chatController?.close()
  r1Music?.close()
  topicSummaries?.close()
  automaticMemory?.close()
  nativeVoice?.close()
  r1Tasks?.close()
  r1Diagnostics?.close()
  r1Focus?.close()
  reminderScheduler?.stop()
  void Promise.allSettled([dataManagement?.whenIdle(), r1Music?.whenIdle(), r1TaskRunner?.close(), automaticMemory?.whenIdle(), topicSummaries?.whenIdle()]).then(() => {
    r1Database?.close(); r1Database = null
    try {
      if (dataManagement?.hasPendingRestore()) {
        dataManagement.runAfterDatabaseClosed()
        app.relaunch()
      }
    } finally { shutdownFinished = true; app.quit() }
  })
})

app.on('window-all-closed', () => {
  // The quit path already drained these services and closed SQLite. Window
  // destruction during the final app.quit must not start new database reads.
  if (shutdownStarted) return
  topicSummaries?.invalidate()
  automaticMemory?.invalidate()
  memoryConfirmations?.revokeAll()
  r1SessionMode.currentPlayingTrackKey = null
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
