import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

export const CREDENTIAL_FIELDS = [
  'VOLCENGINE_ARK_API_KEY',
  'VOLCENGINE_ARK_MODEL',
  'VOLCENGINE_ASR_APP_ID',
  'VOLCENGINE_ASR_ACCESS_TOKEN',
  'VOLCENGINE_STREAM_ASR_API_KEY',
  'VOLCENGINE_TTS_API_KEY',
  'VOLCENGINE_TTS_VOICE',
  'BRAVE_SEARCH_API_KEY'
] as const

export type CredentialField = (typeof CREDENTIAL_FIELDS)[number]
export type CredentialPatch = Partial<Record<CredentialField, string | null>>
export type CredentialStatus = Record<CredentialField, boolean>

type SecretStorage = {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(cipherText: Buffer): string
}

export class CredentialVault {
  private values: Partial<Record<CredentialField, string>> = {}

  constructor(private readonly path: string, private readonly storage: SecretStorage = safeStorage) {}

  load(): CredentialStatus {
    if (existsSync(this.path)) {
      if (!this.storage.isEncryptionAvailable()) throw new Error('SYSTEM_SECRET_STORAGE_UNAVAILABLE')
      const decrypted = this.storage.decryptString(readFileSync(this.path))
      const parsed: unknown = JSON.parse(decrypted)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CREDENTIAL_FILE_INVALID')
      for (const field of CREDENTIAL_FIELDS) {
        const value = (parsed as Record<string, unknown>)[field]
        if (typeof value === 'string' && value.trim()) this.values[field] = value
      }
    }
    this.applyToRuntime()
    return this.status()
  }

  status(): CredentialStatus {
    return Object.fromEntries(CREDENTIAL_FIELDS.map((field) => [field,
      Boolean(this.values[field]?.trim())])) as CredentialStatus
  }

  save(patch: CredentialPatch): CredentialStatus {
    if (!this.storage.isEncryptionAvailable()) throw new Error('SYSTEM_SECRET_STORAGE_UNAVAILABLE')
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('INVALID_CREDENTIAL_PATCH')
    const next = { ...this.values }
    for (const [field, value] of Object.entries(patch)) {
      if (!CREDENTIAL_FIELDS.includes(field as CredentialField)) throw new Error('CREDENTIAL_FIELD_NOT_ALLOWED')
      if (value === null) {
        delete next[field as CredentialField]
      } else if (typeof value === 'string' && value.trim() && value.length <= 1000) {
        next[field as CredentialField] = value.trim()
      } else {
        throw new Error('INVALID_CREDENTIAL_VALUE')
      }
    }
    const encrypted = this.storage.encryptString(JSON.stringify(next))
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.path}.tmp`
    writeFileSync(temporaryPath, encrypted, { mode: 0o600 })
    renameSync(temporaryPath, this.path)
    this.values = next
    for (const field of Object.keys(patch) as CredentialField[]) {
      if (next[field]) process.env[field] = next[field]
      else delete process.env[field]
    }
    this.applyToRuntime()
    return this.status()
  }

  private applyToRuntime(): void {
    for (const field of CREDENTIAL_FIELDS) {
      // Existing process configuration is useful during local development.
      // A packaged app loads only the encrypted vault; no .env ships with it.
      if (this.values[field] && !process.env[field]) process.env[field] = this.values[field]
    }
  }
}
