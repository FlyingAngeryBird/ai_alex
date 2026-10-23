// Reference only: serves the existing PRD prototype in a matched content viewport.
// Start Vite on 127.0.0.1:59541 before using --prototype-reference.
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
const directory = process.env.SEAMO_R1_UI_CHECK_ROOT
if (!directory || !directory.includes('seamo-r1-ui-check-')) throw new Error('ISOLATED_UI_DIRECTORY_REQUIRED')
app.setPath('userData', join(directory, 'chromium-data'))
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1280, height: 708, useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false } })
  window.on('page-title-updated', event => event.preventDefault())
  await window.loadURL('http://127.0.0.1:59541/' + encodeURI('Seamo-AI语音助手/交互原型/R1/index.html'))
  window.setTitle('Seamo R1 Prototype Reference')
  console.log(JSON.stringify({ phase: 'prototype-loaded', viewport: window.getContentSize(), visualAcceptance: false }))
})
app.on('window-all-closed', () => app.quit())
