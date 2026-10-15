import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reference = process.argv.includes('--prototype-reference')
if (!existsSync(join(project, 'dist-electron/main/index.js'))) throw new Error('BUILD_REQUIRED')
const directory = mkdtempSync(join(tmpdir(), 'seamo-r1-ui-check-'))
mkdirSync(join(directory, 'application-data', 'Seamo AI R1'), { recursive: true })
symlinkSync(join(project, 'r1-assets'), join(directory, 'r1-assets'))
writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'seamo-r1-isolated-ui-check', version: '0.0.0', type: 'module', main: join(project, reference ? 'tests/fixtures/prototype-ui-bootstrap.mjs' : 'tests/fixtures/desktop-ui-bootstrap.mjs') }))
const child = spawn(join(project, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [directory], {
  cwd: directory, env: { ...process.env, ELECTRON_RENDERER_URL: '', SEAMO_R1_UI_CHECK_ROOT: directory,
    SEAMO_R1_UI_LIFECYCLE_CHECK: process.argv.includes('--lifecycle-only') ? '1' : '' }, stdio: 'inherit'
})
console.log(JSON.stringify({ scope: reference ? 'prototype_reference_only' : 'production_entry_with_empty_isolated_data', userDataImported: false, servicesConfigured: false, directory, pid: child.pid }))
child.on('exit', (code, signal) => {
  // Chromium may write until process exit; never remove its data in will-quit.
  rmSync(directory, { recursive: true, force: true })
  console.log(JSON.stringify({ phase: 'process-exited', code, signal, isolatedDirectoryRemoved: !existsSync(directory) }))
  process.exitCode = code ?? 1
})
