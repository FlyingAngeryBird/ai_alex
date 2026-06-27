import { ipcMain } from 'electron'

type AppResult<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: {
        code: string
        message: string
      }
    }

type RuntimeState = {
  platform: NodeJS.Platform
  ready: true
  musicProvider: 'apple-music'
}

function ok<T>(data: T): AppResult<T> {
  return {
    ok: true,
    data
  }
}

export function registerAppHandlers(): void {
  ipcMain.handle('app.getRuntimeState', () =>
    ok<RuntimeState>({
      platform: process.platform,
      ready: true,
      musicProvider: 'apple-music'
    })
  )
}
