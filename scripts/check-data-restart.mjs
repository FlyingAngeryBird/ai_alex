import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'seamo-r1-data-restart-'))
symlinkSync(join(project, 'r1-assets'), join(root, 'r1-assets'))
writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'seamo-r1-data-restart-check', version: '0.0.0', type: 'module', main: join(project, 'tests/fixtures/data-restart-bootstrap.mjs') }))
const child = spawn(join(project, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), [root], { cwd: root,
  env: { ...process.env, ELECTRON_RENDERER_URL: '', SEAMO_R1_DATA_RESTART_ROOT: root }, stdio: 'inherit' })
console.log(JSON.stringify({ phase: 'production-restart-check-started', root, pid: child.pid }))
await new Promise(resolve => child.once('exit', resolve))
const deadline = Date.now() + 30000, resultPath = join(root, 'result.json')
while (!existsSync(resultPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250))
if (!existsSync(resultPath)) { console.log(JSON.stringify({ passed: false, code: 'RELAUNCH_RESULT_NOT_OBSERVED', root })); process.exitCode = 1 }
else { const result = JSON.parse(readFileSync(resultPath, 'utf8')); console.log(JSON.stringify(result)); process.exitCode = result.passed ? 0 : 1 }
