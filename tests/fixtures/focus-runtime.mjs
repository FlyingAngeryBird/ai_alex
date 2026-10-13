// Isolated integration fixture. Never imports production main or user's data directory.
import { app, BrowserWindow, powerMonitor } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openR1Database } from '../../dist-electron/main/r1/database.js'
import { R1Focus } from '../../dist-electron/main/r1/focus.js'
import { registerFocusHandlers } from '../../dist-electron/main/ipc/focusHandlers.js'
const dataDir = mkdtempSync(join(tmpdir(), 'seamo-focus-runtime-'))
app.setName('Seamo Focus Runtime Check')
app.setPath('userData', dataDir)
let service, db
void app.whenReady().then(async () => {
db = openR1Database(join(dataDir, 'test.sqlite'))
service = new R1Focus(db)
registerFocusHandlers(service)
service.onChanged(event => {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('r1.focusChanged', event)
})
powerMonitor.on('suspend', () => service.suspend())
powerMonitor.on('resume', () => service.wake())
const window = new BrowserWindow({ width: 1180, height: 760, title: 'Seamo Focus Runtime Check',
  webPreferences: { preload: resolve('dist-electron/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } })
await window.loadURL('http://127.0.0.1:59541/tests/fixtures/focus-harness.html')
service.startScheduler()
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { service?.close(); db?.close(); rmSync(dataDir, { recursive: true, force: true }) })
})
