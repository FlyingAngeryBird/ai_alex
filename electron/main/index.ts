import { app, BrowserWindow } from 'electron'
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
import type { MusicTrack } from './music/gdstudioMusicProvider.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
let r1Database: R1Database | null = null

// R1 keeps its data separate from every legacy lingmo build. The old directory
// is only read by the explicit migration path; opening R1 never writes to it.
app.setName('Seamo AI R1')
app.setPath('userData', join(app.getPath('appData'), 'Seamo AI R1'))

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
  try {
    r1Database = openR1Database(join(app.getPath('userData'), 'r1.sqlite'))
    importLegacyJson(r1Database, join(app.getPath('appData'), 'lingli'), 'lingli-json')
    importLegacyJson(r1Database, join(app.getPath('appData'), 'lingmo'), 'lingmo-json')
    registerR1Handlers(r1Database)
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('before-quit', () => {
  r1Database?.close()
  r1Database = null
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
