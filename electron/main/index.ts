import { app, BrowserWindow } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const __dirname = dirname(fileURLToPath(import.meta.url))

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
registerChatHandlers()
registerConfigHandlers()
registerMusicHandlers()
registerTtsHandlers()
registerVoiceHandlers()

void app.whenReady().then(async () => {
  await getDefaultConfigStore().loadConfig()
  await getDefaultMusicStore().loadLibrary()
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
