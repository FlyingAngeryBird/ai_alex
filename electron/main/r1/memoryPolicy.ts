import { inTransaction, type R1Database } from './database.js'
export type MemoryPolicy = { enabled: boolean; version: number }
export class R1MemoryPolicy {
  constructor(private readonly db: R1Database) {}
  get(): MemoryPolicy {
    const row = this.db.prepare('SELECT enabled, version FROM memory_policy WHERE id = 1').get() as { enabled: number; version: number }
    return { enabled: Boolean(row.enabled), version: row.version }
  }
  assertAuthorized(version: number): void {
    const current = this.get()
    if (!current.enabled || current.version !== version) throw new Error('AUTO_MEMORY_AUTHORIZATION_REVOKED')
  }
  update(input: { enabled: boolean; expectedVersion: number }): MemoryPolicy {
    if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new Error('INVALID_MEMORY_POLICY')
    return inTransaction(this.db, () => {
      const current = this.get()
      if (current.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
      if (current.enabled === input.enabled) return current
      this.db.prepare('UPDATE memory_policy SET enabled = ?, version = version + 1, authorized_after_rowid=(SELECT COALESCE(MAX(rowid),0) FROM messages), updated_at = ? WHERE id = 1')
        .run(Number(input.enabled), new Date().toISOString())
      return this.get()
    })
  }
}
