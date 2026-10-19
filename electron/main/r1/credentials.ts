import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeStorage } from 'electron'

export const CREDENTIAL_FIELDS = [
  'VOLCENGINE_ARK_API_KEY',
  'VOLCENGINE_ARK_MODEL',
  'VOLCENGINE_REALTIME_API_KEY',
  'VOLCENGINE_REALTIME_VOICE',
  'VOLCENGINE_ASR_APP_ID',
  'VOLCENGINE_ASR_ACCESS_TOKEN',
  'VOLCENGINE_STREAM_ASR_API_KEY',
  'VOLCENGINE_TTS_API_KEY',
  'VOLCENGINE_TTS_VOICE',
  'BRAVE_SEARCH_API_KEY', // Preserve old vault data for explicit rollback; never used as a Doubao key.
  'DOUBAO_SEARCH_API_KEY'
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
  private currentRevision = 0
  private loadFailure: string | null = null
  private loading = false
  get revision(): number { return this.currentRevision }
  get needsReload(): boolean { return this.loadFailure !== null }
  get isLoading(): boolean { return this.loading }
  /** Mark the deferred startup read as in flight so status never reports an empty vault as unconfigured. */
  beginLoad(): void { this.loading = true }

  constructor(private readonly path: string, private readonly storage: SecretStorage = safeStorage) {}

  load(): CredentialStatus {
    this.loading = true
    try {
      const next: Partial<Record<CredentialField, string>> = {}
      if (existsSync(this.path)) {
        if (!this.storage.isEncryptionAvailable()) throw new Error('SYSTEM_SECRET_STORAGE_UNAVAILABLE')
        const decrypted = this.storage.decryptString(readFileSync(this.path))
        const parsed: unknown = JSON.parse(decrypted)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CREDENTIAL_FILE_INVALID')
        for (const field of CREDENTIAL_FIELDS) {
          const value = (parsed as Record<string, unknown>)[field]
          if (typeof value === 'string' && value.trim()) next[field] = value
        }
      }
      this.values = next; this.loadFailure = null
      this.applyToRuntime()
      this.currentRevision++
      this.loading = false
      return this.status()
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      this.loadFailure = message === 'SYSTEM_SECRET_STORAGE_UNAVAILABLE' ? 'SYSTEM_SECRET_STORAGE_UNAVAILABLE'
        : message === 'CREDENTIAL_FILE_INVALID' ? 'CREDENTIAL_FILE_INVALID' : 'CREDENTIAL_DECRYPT_FAILED'
      this.values = {}
      for (const field of CREDENTIAL_FIELDS) delete process.env[field]
      this.currentRevision++
      throw new Error(this.loadFailure)
    } finally {
      this.loading = false
    }
  }

  status(): CredentialStatus {
    if (this.loading) throw new Error('CREDENTIAL_LOAD_PENDING')
    if (this.loadFailure) throw new Error(this.loadFailure)
    return Object.fromEntries(CREDENTIAL_FIELDS.map((field) => [field,
      Boolean(this.values[field]?.trim() || process.env[field]?.trim())])) as CredentialStatus
  }

  save(patch: CredentialPatch): CredentialStatus {
    // Never merge a patch with an unreadable vault or overwrite its remaining keys.
    if (this.loadFailure) this.load()
    if (!this.storage.isEncryptionAvailable()) throw new Error('SYSTEM_SECRET_STORAGE_UNAVAILABLE')
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('INVALID_CREDENTIAL_PATCH')
    const next = { ...this.values }
    for (const [field, value] of Object.entries(patch)) {
      if (!CREDENTIAL_FIELDS.includes(field as CredentialField)) throw new Error('CREDENTIAL_FIELD_NOT_ALLOWED')
      if (value === null) {
        delete next[field as CredentialField]
      } else if (typeof value === 'string' && value.trim() && value.length <= 1000 && !/[\r\n\x00]/.test(value)) {
        if (field === 'VOLCENGINE_REALTIME_VOICE' && !/^[A-Za-z0-9_.-]{1,200}$/.test(value.trim())) {
          throw new Error('INVALID_REALTIME_VOICE')
        }
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
    this.currentRevision++
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
      if (this.values[field]) process.env[field] = this.values[field]
    }
  }
}
