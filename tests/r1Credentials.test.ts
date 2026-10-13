import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

import { CredentialVault } from '../electron/main/r1/credentials'

const directories: string[] = []
const originalKey = process.env.VOLCENGINE_ARK_API_KEY

function makePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seamo-vault-'))
  directories.push(directory)
  return join(directory, 'credentials.bin')
}

afterEach(() => {
  if (originalKey === undefined) delete process.env.VOLCENGINE_ARK_API_KEY
  else process.env.VOLCENGINE_ARK_API_KEY = originalKey
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
})
