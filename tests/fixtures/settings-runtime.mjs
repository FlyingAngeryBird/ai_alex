import { app, BrowserWindow } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openR1Database } from '../../dist-electron/main/r1/database.js'
import { R1PersonaStore } from '../../dist-electron/main/r1/persona.js'
import { CredentialVault, CREDENTIAL_FIELDS } from '../../dist-electron/main/r1/credentials.js'
import { R1ServiceDiagnostics } from '../../dist-electron/main/r1/serviceDiagnostics.js'
import { loadR1PromptAssets } from '../../dist-electron/main/r1/promptAssets.js'
import { registerR1Handlers } from '../../dist-electron/main/ipc/r1Handlers.js'
import { registerCredentialHandlers } from '../../dist-electron/main/ipc/credentialHandlers.js'
import { registerServiceHandlers } from '../../dist-electron/main/ipc/serviceHandlers.js'
for (const field of CREDENTIAL_FIELDS) delete process.env[field]
const directory = mkdtempSync(join(tmpdir(), 'seamo-settings-runtime-'))
app.setName('Seamo Settings Runtime Check')
app.setPath('userData', directory)
let db, diagnostics
void app.whenReady().then(async () => {
  db = openR1Database(join(directory, 'test.sqlite'))
  const vault = new CredentialVault(join(directory, 'credentials.bin'))
  await vault.load()
  diagnostics = new R1ServiceDiagnostics(vault, loadR1PromptAssets(resolve('r1-assets')), new R1PersonaStore(db))
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => { diagnostics?.close(); db?.close(); rmSync(directory, { recursive: true, force: true }) })
  registerR1Handlers(db)
  registerCredentialHandlers(vault)
  registerServiceHandlers(diagnostics)
  const window = new BrowserWindow({ width: 1180, height: 760, title: 'Seamo Settings Runtime Check',
    webPreferences: { preload: resolve('dist-electron/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } })
  await window.loadURL('http://127.0.0.1:59541/tests/fixtures/settings-harness.html')
}).catch(() => { app.quit() })
