import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false }, ipcMain: {} }))

import { CredentialVault, CREDENTIAL_FIELDS } from '../electron/main/r1/credentials'
import { registerCredentialHandlers } from '../electron/main/ipc/credentialHandlers'

const directories: string[] = []
const originalEnv = Object.fromEntries(CREDENTIAL_FIELDS.map(field => [field, process.env[field]]))

function makePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seamo-vault-'))
  directories.push(directory)
  return join(directory, 'credentials.bin')
}

afterEach(() => {
  for (const field of CREDENTIAL_FIELDS) {
    if (originalEnv[field] === undefined) delete process.env[field]
    else process.env[field] = originalEnv[field]
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('R1 encrypted credential vault', () => {
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`encrypted:${Buffer.from(plain).toString('base64')}`),
    decryptString: (cipher: Buffer) => Buffer.from(cipher.toString().slice('encrypted:'.length), 'base64').toString()
  }

  it('persists only encrypted bytes with private permissions and restores without exposing the key', () => {
    const path = makePath()
    const vault = new CredentialVault(path, storage)
    expect(vault.save({ VOLCENGINE_ARK_API_KEY: 'test-secret-value' }).VOLCENGINE_ARK_API_KEY).toBe(true)
    expect(readFileSync(path, 'utf8')).not.toContain('test-secret-value')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    delete process.env.VOLCENGINE_ARK_API_KEY
    const reopened = new CredentialVault(path, storage)
    expect(reopened.load().VOLCENGINE_ARK_API_KEY).toBe(true)
    expect(process.env.VOLCENGINE_ARK_API_KEY).toBe('test-secret-value')
    expect(reopened.save({ VOLCENGINE_ARK_API_KEY: null }).VOLCENGINE_ARK_API_KEY).toBe(false)
    expect(process.env.VOLCENGINE_ARK_API_KEY).toBeUndefined()
  })

  it('rejects unexpected fields and unavailable encryption without writing a file', () => {
    const path = makePath()
    const vault = new CredentialVault(path, { ...storage, isEncryptionAvailable: () => false })
    expect(() => vault.save({ VOLCENGINE_ARK_API_KEY: 'x' })).toThrow('SYSTEM_SECRET_STORAGE_UNAVAILABLE')
    expect(() => new CredentialVault(path, storage).save({ arbitrary: 'x' } as never))
      .toThrow('CREDENTIAL_FIELD_NOT_ALLOWED')
    expect(() => readFileSync(path)).toThrow()
  })
  it('keeps independent search, Ark and legacy keys separate across a partial save and reopen', () => {
    const path = makePath(), vault = new CredentialVault(path, storage)
    vault.save({ VOLCENGINE_ARK_API_KEY: 'ark-only', BRAVE_SEARCH_API_KEY: 'legacy-only', VOLCENGINE_REALTIME_API_KEY: 'voice-only' })
    expect(vault.status().DOUBAO_SEARCH_API_KEY).toBe(false)
    vault.save({ DOUBAO_SEARCH_API_KEY: 'search-only' })
    const reopened = new CredentialVault(path, storage)
    expect(reopened.load()).toMatchObject({ DOUBAO_SEARCH_API_KEY: true, BRAVE_SEARCH_API_KEY: true, VOLCENGINE_ARK_API_KEY: true, VOLCENGINE_REALTIME_API_KEY: true })
    expect(process.env.DOUBAO_SEARCH_API_KEY).toBe('search-only')
    expect(process.env.VOLCENGINE_ARK_API_KEY).toBe('ark-only')
    expect(process.env.BRAVE_SEARCH_API_KEY).toBe('legacy-only')
    expect(readFileSync(path, 'utf8')).not.toContain('search-only')
    expect(reopened.save({ DOUBAO_SEARCH_API_KEY: null })).toMatchObject({ DOUBAO_SEARCH_API_KEY: false, VOLCENGINE_ARK_API_KEY: true, VOLCENGINE_REALTIME_API_KEY: true })
  })
  it('keeps native realtime credentials distinct, overrides stale local env on reopen and rejects header injection', () => {
    const path = makePath()
    const vault = new CredentialVault(path, storage)
    const initial = vault.revision
    const status = vault.save({ VOLCENGINE_REALTIME_API_KEY: 'native-secret', VOLCENGINE_REALTIME_VOICE: 'test_voice' })
    expect(status.VOLCENGINE_REALTIME_API_KEY).toBe(true)
    expect(vault.revision).toBeGreaterThan(initial)
    process.env.VOLCENGINE_REALTIME_API_KEY = 'stale-development-key'
    const reopened = new CredentialVault(path, storage)
    reopened.load()
    expect(process.env.VOLCENGINE_REALTIME_API_KEY).toBe('native-secret')
    expect(readFileSync(path, 'utf8')).not.toContain('native-secret')
    expect(() => reopened.save({ VOLCENGINE_REALTIME_API_KEY: 'key\r\nOther: value' })).toThrow('INVALID_CREDENTIAL_VALUE')
    expect(() => reopened.save({ VOLCENGINE_REALTIME_VOICE: 'not valid voice' })).toThrow('INVALID_REALTIME_VOICE')
  })
  it('preserves encrypted bytes and blocks partial overwrite while locked, then reloads all keys before saving', () => {
    const path = makePath()
    new CredentialVault(path, storage).save({ VOLCENGINE_REALTIME_API_KEY: 'test-native', VOLCENGINE_REALTIME_VOICE: 'test_voice' })
    const bytes = readFileSync(path)
    let unlocked = false
    const vault = new CredentialVault(path, { ...storage, isEncryptionAvailable: () => unlocked })
    expect(() => vault.load()).toThrow('SYSTEM_SECRET_STORAGE_UNAVAILABLE')
    expect(vault.needsReload).toBe(true)
    expect(() => vault.status()).toThrow('SYSTEM_SECRET_STORAGE_UNAVAILABLE')
    expect(process.env.VOLCENGINE_REALTIME_API_KEY).toBeUndefined()
    expect(() => vault.save({ VOLCENGINE_ARK_MODEL: 'test_model' })).toThrow('SYSTEM_SECRET_STORAGE_UNAVAILABLE')
    expect(readFileSync(path)).toEqual(bytes)
    unlocked = true
    const status = vault.save({ VOLCENGINE_ARK_MODEL: 'test_model' })
    expect(status.VOLCENGINE_REALTIME_API_KEY).toBe(true)
    expect(status.VOLCENGINE_REALTIME_VOICE).toBe(true)
    expect(status.VOLCENGINE_ARK_MODEL).toBe(true)
    expect(vault.needsReload).toBe(false)
    expect(process.env.VOLCENGINE_REALTIME_API_KEY).toBe('test-native')
  })
  it('does not overwrite or expose an undecryptable vault', () => {
    const path = makePath()
    new CredentialVault(path, storage).save({ VOLCENGINE_REALTIME_API_KEY: 'test-native' })
    const bytes = readFileSync(path)
    const vault = new CredentialVault(path, { ...storage, decryptString() { throw new Error('private provider key') } })
    expect(() => vault.load()).toThrow('CREDENTIAL_LOAD_FAILED')
    expect(() => vault.save({ VOLCENGINE_REALTIME_VOICE: 'test_voice' })).toThrow('CREDENTIAL_LOAD_FAILED')
    expect(readFileSync(path)).toEqual(bytes)
  })
  it('returns an unavailable IPC result and retries the preserved vault after the system is unlocked', () => {
    const path = makePath()
    new CredentialVault(path, storage).save({ VOLCENGINE_REALTIME_API_KEY: 'test-native' })
    let unlocked = false
    const vault = new CredentialVault(path, { ...storage, isEncryptionAvailable: () => unlocked })
    expect(() => vault.load()).toThrow()
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
    registerCredentialHandlers(vault, { handle: (name, handler) => { handlers.set(name, handler) } })
    expect(handlers.get('r1.credentials.status')!({})).toMatchObject({ ok: false, error: { code: 'SYSTEM_SECRET_STORAGE_UNAVAILABLE' } })
    unlocked = true
    const result = handlers.get('r1.credentials.status')!({})
    expect(result).toMatchObject({ ok: true, data: { VOLCENGINE_REALTIME_API_KEY: true } })
    expect(JSON.stringify(result)).not.toContain('test-native')
  })
})
