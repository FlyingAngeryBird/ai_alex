import type { BrowserWindowConstructorOptions } from 'electron'

export function createMainWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    title: 'lingmo',
    backgroundColor: '#080910',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  }
}
