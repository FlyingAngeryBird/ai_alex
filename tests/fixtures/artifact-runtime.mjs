import { app, BrowserWindow } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openR1Database } from '../../dist-electron/main/r1/database.js'
import { R1Artifacts } from '../../dist-electron/main/r1/artifacts.js'
import { R1TaskSupervisor } from '../../dist-electron/main/r1/taskSupervisor.js'
import { loadR1PromptAssets } from '../../dist-electron/main/r1/promptAssets.js'
import { registerTaskHandlers } from '../../dist-electron/main/ipc/taskHandlers.js'
import { registerR1Handlers } from '../../dist-electron/main/ipc/r1Handlers.js'
const directory = mkdtempSync(join(tmpdir(), 'seamo-artifact-runtime-'))
app.setName('Seamo Artifact Runtime Check')
app.setPath('userData', directory)
let db, tasks, testWindow
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { tasks?.close(); db?.close(); rmSync(directory, { recursive: true, force: true }) })
void app.whenReady().then(async () => {
  db = openR1Database(join(directory, 'test.sqlite'))
  const artifacts = new R1Artifacts(db)
  tasks = new R1TaskSupervisor(db, loadR1PromptAssets(resolve('r1-assets')), () => 0)
  registerR1Handlers(db)
  registerTaskHandlers(tasks, artifacts, { temporary: false, sessionId: null })
  const artifact = artifacts.create({ sourceTurnId: 'isolated-test', draft: { kind: 'text', title: '独立测试工作稿',
    content: '第一段\n\n第二段', baseArtifactId: null, baseArtifactVersion: null, sourceRefs: [] } })
  testWindow = new BrowserWindow({ width: 1000, height: 800, title: 'Seamo Artifact Runtime Check',
    webPreferences: { preload: resolve('dist-electron/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } })
  await testWindow.loadURL(`http://127.0.0.1:59541/tests/fixtures/artifact-runtime.html?id=${artifact.artifactId}`)
}).catch(error => { console.error(error); app.quit() })
