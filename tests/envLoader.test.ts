import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnvironmentFiles } from '../electron/main/env'
import { resolveEnvironmentCandidateDirectories } from '../electron/main/env'

const tempDirs: string[] = []

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lingmo-env-'))
  tempDirs.push(dir)
  return dir
}

describe('main process environment loader', () => {
  afterEach(() => {
    delete process.env.LINGMO_ENV_TEST_VALUE
    delete process.env.LINGMO_ENV_KEEP_VALUE
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, {
        force: true,
        recursive: true
      })
    }
  })

  it('loads the first available .env file from candidate directories', () => {
    const first = createTempDir()
    const second = createTempDir()
    writeFileSync(join(second, '.env'), 'LINGMO_ENV_TEST_VALUE=loaded\n')

    const loaded = loadEnvironmentFiles([first, second])

    expect(loaded).toEqual([join(second, '.env')])
    expect(process.env.LINGMO_ENV_TEST_VALUE).toBe('loaded')
  })

  it('does not override environment variables that are already set', () => {
    const dir = createTempDir()
    process.env.LINGMO_ENV_KEEP_VALUE = 'existing'
    writeFileSync(join(dir, '.env'), 'LINGMO_ENV_KEEP_VALUE=from-file\n')

    loadEnvironmentFiles([dir])

    expect(process.env.LINGMO_ENV_KEEP_VALUE).toBe('existing')
  })

  it('includes the Electron app path and built main directory project root as env candidates', () => {
    const candidates = resolveEnvironmentCandidateDirectories({
      appPath: '/Users/sea/Documents/ai_alex',
      cwd: '/',
      mainDir: '/Users/sea/Documents/ai_alex/dist-electron/main',
      userDataPath: '/Users/sea/Library/Application Support/lingli'
    })

    expect(candidates).toContain('/Users/sea/Documents/ai_alex')
    expect(candidates).toContain('/Users/sea/Library/Application Support/lingli')
    expect(candidates.indexOf('/Users/sea/Documents/ai_alex')).toBeLessThan(
      candidates.indexOf('/Users/sea/Library/Application Support/lingli')
    )
  })
})
