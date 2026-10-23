import { ipcMain, BrowserWindow } from 'electron'
import type { PreferencesPatch, R1Preferences } from '../r1/preferences.js'
type Ipc = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void }
export function registerPreferencesHandlers(preferences: R1Preferences, ipc: Ipc = ipcMain,
  broadcast: (value: ReturnType<R1Preferences['get']>) => void = value => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send('r1.preferencesChanged', value)
  }): void {
  ipc.handle('r1.preferences.get', () => ({ ok: true, data: preferences.get() }))
  ipc.handle('r1.preferences.update', (_event, payload) => {
    try { return { ok: true, data: preferences.update(payload as PreferencesPatch) } }
    catch (error) { const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'PREFERENCES_SAVE_FAILED'; return { ok: false, error: { code, message: code } } }
  })
  preferences.onChanged(broadcast)
}
