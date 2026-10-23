import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, openSync, closeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
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
  isEncryptionAvailable(): boolean | Promise<boolean>
  encryptString(plainText: string): Buffer | Promise<Buffer>
  decryptString(cipherText: Buffer): string | Promise<string>
}

// Electron's async API uses the OS-backed encryptor without blocking the main
// event loop. Do not fall back to plaintext or the legacy synchronous API.
const systemStorage: SecretStorage = {
  isEncryptionAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encryptString: text => safeStorage.encryptStringAsync(text),
  decryptString: async bytes => (await safeStorage.decryptStringAsync(bytes)).result
}

export class CredentialVault {
  private values: Partial<Record<CredentialField, string>> = {}
  private currentRevision = 0
  private loadFailure: string | null = null
  private loading = false
  private initialized = false
  private tail: Promise<unknown> = Promise.resolve()
  private pendingStorage: Promise<unknown> | null = null
  private pendingLoad: Promise<CredentialStatus> | null = null
  get revision(): number { return this.currentRevision }
  get needsReload(): boolean { return this.loadFailure !== null }
  get isLoading(): boolean { return this.loading }
  beginLoad(): void { this.loading = true }

  constructor(private readonly path: string, private readonly storage: SecretStorage = systemStorage,
    private readonly storageTimeoutMs = 8000) {}

  // Loads and writes share one queue, so a delayed startup read cannot overwrite
  // a newer save, and concurrent partial patches cannot drop each other's keys.
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(action)
    this.tail = operation.catch(() => undefined)
    return operation
  }

  private async callStorage<T>(action: () => T | Promise<T>): Promise<T> {
    // A timed-out native request cannot be cancelled. Keep its slot occupied
    // until it settles, so repeated button clicks cannot queue native prompts.
    if (this.pendingStorage) throw new Error('SYSTEM_SECRET_STORAGE_TIMEOUT')
    const request = Promise.resolve().then(action)
    this.pendingStorage = request
    void request.finally(() => { if (this.pendingStorage === request) this.pendingStorage = null }).catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([request, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SYSTEM_SECRET_STORAGE_TIMEOUT')), this.storageTimeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }

  load(): Promise<CredentialStatus> {
    if (this.pendingLoad) return this.pendingLoad
    this.loading = true
    const operation = this.enqueue(() => this.read())
    this.pendingLoad = operation
    // Keep rejection handling on the returned promise; callers receive a safe code.
    void operation.finally(() => { this.pendingLoad = null; this.loading = false }).catch(() => undefined)
    return operation
  }

  private async read(): Promise<CredentialStatus> {
    let failure = 'CREDENTIAL_LOAD_FAILED'
    try {
      const next: Partial<Record<CredentialField, string>> = {}
      if (existsSync(this.path)) {
        const bytes = readFileSync(this.path)
        failure = 'SYSTEM_SECRET_STORAGE_UNAVAILABLE'
        if (!await this.callStorage(() => this.storage.isEncryptionAvailable())) throw new Error(failure)
        failure = 'CREDENTIAL_DECRYPT_FAILED'
        const decrypted = await this.callStorage(() => this.storage.decryptString(bytes))
        failure = 'CREDENTIAL_FILE_INVALID'
        const parsed: unknown = JSON.parse(decrypted)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(failure)
        for (const field of CREDENTIAL_FIELDS) {
          const value = (parsed as Record<string, unknown>)[field]
          if (value !== undefined && (typeof value !== 'string' || !value.trim())) throw new Error(failure)
          if (typeof value === 'string') next[field] = value
        }
      }
      this.values = next; this.loadFailure = null; this.initialized = true
      this.applyToRuntime()
      this.currentRevision++
      return this.currentStatus()
    } catch (error) {
      this.loadFailure = error instanceof Error && error.message === 'SYSTEM_SECRET_STORAGE_TIMEOUT'
        ? 'SYSTEM_SECRET_STORAGE_TIMEOUT' : failure
      this.values = {}
      for (const field of CREDENTIAL_FIELDS) delete process.env[field]
      this.currentRevision++
      throw new Error(this.loadFailure)
    }
  }

  private currentStatus(): CredentialStatus {
    return Object.fromEntries(CREDENTIAL_FIELDS.map((field) => [field,
      Boolean(this.values[field]?.trim() || process.env[field]?.trim())])) as CredentialStatus
  }

  // Pure status: polling never touches Keychain or prompts for authorization.
  status(): CredentialStatus {
    if (this.loading) throw new Error('CREDENTIAL_LOAD_PENDING')
    if (this.loadFailure) throw new Error(this.loadFailure)
    return this.currentStatus()
  }

  diagnosticStatus(): { state: string; configured: CredentialStatus | null } {
    return { state: this.loading ? 'CREDENTIAL_LOAD_PENDING' : this.loadFailure ?? 'ready',
      configured: this.loading || this.loadFailure ? null : this.currentStatus() }
  }

  save(patch: CredentialPatch): Promise<CredentialStatus> {
    return this.enqueue(async () => {
      // A failed read requires explicit reload or recovery. Saving a partial
      // patch must not silently retry native authorization or discard old keys.
      if (this.loadFailure) throw new Error(this.loadFailure)
      if (!this.initialized && existsSync(this.path)) await this.read()
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('INVALID_CREDENTIAL_PATCH')
      const next = this.validatePatch(this.values, patch)
      await this.write(next)
      this.values = next; this.initialized = true
      this.currentRevision++
      for (const field of Object.keys(patch) as CredentialField[]) {
        if (next[field]) process.env[field] = next[field]
        else delete process.env[field]
      }
      this.applyToRuntime()
      return this.currentStatus()
    })
  }

  private async encrypt(next: Partial<Record<CredentialField, string>>): Promise<Buffer> {
    if (!await this.callStorage(() => this.storage.isEncryptionAvailable())) throw new Error('SYSTEM_SECRET_STORAGE_UNAVAILABLE')
    return this.callStorage(() => this.storage.encryptString(JSON.stringify(next)))
  }

  private publish(encrypted: Buffer): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.path}.tmp`
    // Exclusive creation prevents following a stale temporary file/symlink.
    let descriptor: number | undefined
    let created = false
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600); created = true
      writeFileSync(descriptor, encrypted)
      closeSync(descriptor); descriptor = undefined
      renameSync(temporaryPath, this.path)
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor)
      if (created) rmSync(temporaryPath, { force: true })
      throw error
    }
  }

  private async write(next: Partial<Record<CredentialField, string>>): Promise<void> {
    this.publish(await this.encrypt(next))
  }

  /** Explicit recovery creates a new encrypted file from newly entered fields.
   * The old encrypted file remains recoverable; no automatic migration occurs. */
  recover(patch: CredentialPatch): Promise<CredentialStatus> {
    return this.enqueue(async () => {
      if (!this.loadFailure) throw new Error('CREDENTIAL_RECOVERY_NOT_REQUIRED')
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) throw new Error('INVALID_CREDENTIAL_PATCH')
      const next = this.validatePatch({}, patch)
      // Finish native encryption before moving any existing user file.
      const encrypted = await this.encrypt(next)
      const backupPath = `${this.path}.recovered-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.bak`
      let moved = false
      try {
        if (existsSync(this.path)) { renameSync(this.path, backupPath); moved = true }
        this.publish(encrypted)
      } catch (error) {
        if (moved) { try { renameSync(backupPath, this.path) } catch { /* preserved backup remains intact */ } }
        throw error
      }
      this.values = next; this.loadFailure = null; this.initialized = true
      this.currentRevision++
      for (const field of CREDENTIAL_FIELDS) { if (next[field]) process.env[field] = next[field]; else delete process.env[field] }
      this.loading = false
      return this.currentStatus()
    })
  }

  private validatePatch(base: Partial<Record<CredentialField, string>>, patch: CredentialPatch): Partial<Record<CredentialField, string>> {
    const next = { ...base }
    for (const [field, value] of Object.entries(patch)) {
      if (!CREDENTIAL_FIELDS.includes(field as CredentialField)) throw new Error('CREDENTIAL_FIELD_NOT_ALLOWED')
      if (value === null) delete next[field as CredentialField]
      else if (typeof value === 'string' && value.trim() && value.length <= 1000 && !/[\r\n\x00]/.test(value)) {
        if (field === 'VOLCENGINE_REALTIME_VOICE' && !/^[A-Za-z0-9_.-]{1,200}$/.test(value.trim())) {
          throw new Error('INVALID_REALTIME_VOICE')
        }
        next[field as CredentialField] = value.trim()
      } else throw new Error('INVALID_CREDENTIAL_VALUE')
    }
    return next
  }

  private applyToRuntime(): void {
    for (const field of CREDENTIAL_FIELDS) {
      // Existing process configuration is useful during local development.
      // A packaged app loads only the encrypted vault; no .env ships with it.
      if (this.values[field]) process.env[field] = this.values[field]
    }
  }
}
