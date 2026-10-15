// Runs the unchanged production entry against an isolated appData directory.
// No fake domain provider, no copied user records, and no environment credentials.
import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CREDENTIAL_FIELDS } from '../../dist-electron/main/r1/credentials.js'
const directory = process.env.SEAMO_R1_UI_CHECK_ROOT, project = resolve(import.meta.dirname, '../..')
if (!directory || !directory.includes('seamo-r1-ui-check-')) throw new Error('ISOLATED_UI_DIRECTORY_REQUIRED')
for (const candidate of [project, dirname(project), directory]) if (existsSync(join(candidate, '.env'))) throw new Error('UI_CHECK_ENV_FILE_NOT_ALLOWED')
for (const field of CREDENTIAL_FIELDS) delete process.env[field]
app.setPath('appData', join(directory, 'application-data'))
app.setPath('userData', join(directory, 'application-data', 'Seamo AI R1'))
mkdirSync(join(directory, 'chromium-data'), { recursive: true })
app.setPath('sessionData', join(directory, 'chromium-data'))
app.on('browser-window-created', (_event, window) => {
  window.setSize(1280, 820)
  window.on('page-title-updated', event => event.preventDefault())
  window.setTitle('Seamo R1 Isolated UI Check')
  window.webContents.once('did-finish-load', () => {
    window.setTitle('Seamo R1 Isolated UI Check')
    console.log(JSON.stringify({ phase: 'renderer-resource-loaded', viewport: window.getContentSize(), userDataIsolated: true, visualAcceptance: false }))
    if (process.env.SEAMO_R1_UI_LIFECYCLE_CHECK === '1') setTimeout(() => {
      console.log(JSON.stringify({ phase: 'quit-requested' })); app.quit()
    }, 300)
  })
})
app.on('will-quit', () => { console.log(JSON.stringify({ phase: 'will-quit' })) })
process.on('SIGTERM', () => app.quit())
process.on('SIGINT', () => app.quit())
await import(pathToFileURL(join(project, 'dist-electron/main/index.js')).href)
