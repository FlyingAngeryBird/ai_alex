import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { copyProductionDependencies, productionDependencyPaths } from '../scripts/runtime-dependencies.mjs'

it('runs the actual production parsers and transports outside the checkout without ancestor dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'seamo-r1-runtime-test-'))
  try {
    copyProductionDependencies(root, productionDependencyPaths(process.cwd()))
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    writeFileSync(join(root, 'probe.mjs'), 'import {load} from "cheerio"; import {Ajv} from "ajv"; import WebSocket from "ws"; import dotenv from "dotenv"; if(load("<main>actual</main>")("main").text()!=="actual" || !new Ajv().validate({type:"string"},"actual") || typeof WebSocket!=="function" || typeof dotenv.parse!=="function") throw new Error("RUNTIME_INVALID"); console.log("passed");')
    expect(execFileSync(process.execPath, [join(root, 'probe.mjs')], { encoding: 'utf8', timeout: 10000 }).trim()).toBe('passed')
    expect(existsSync(join(root, 'node_modules', 'electron'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 60000)

it('preserves nested dependency versions while excluding nested packages absent from the production graph', () => {
  const root = mkdtempSync(join(tmpdir(), 'seamo-r1-nested-runtime-'))
  const source = join(root, 'source'), app = join(root, 'app')
  try {
    mkdirSync(join(source, 'node_modules', 'same'), { recursive: true })
    mkdirSync(join(source, 'node_modules', 'dev-only'), { recursive: true })
    writeFileSync(join(source, 'package.json'), '{"version":"1"}')
    writeFileSync(join(source, 'node_modules', 'same', 'package.json'), '{"version":"2"}')
    writeFileSync(join(source, 'node_modules', 'dev-only', 'secret.txt'), 'not part of runtime')
    copyProductionDependencies(app, [
      { source, destination: 'node_modules/parent' },
      { source: join(source, 'node_modules', 'same'), destination: 'node_modules/parent/node_modules/same' }
    ])
    expect(JSON.parse(readFileSync(join(app, 'node_modules/parent/package.json'), 'utf8')).version).toBe('1')
    expect(JSON.parse(readFileSync(join(app, 'node_modules/parent/node_modules/same/package.json'), 'utf8')).version).toBe('2')
    expect(existsSync(join(app, 'node_modules/parent/node_modules/dev-only'))).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
