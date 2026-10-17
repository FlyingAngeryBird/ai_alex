import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { R1Database } from './database.js'
import { R1Items } from './items.js'
export type ItemExportInput = { items: { itemId: string; expectedVersion: number }[]; format: 'txt' | 'md' }
export type ExportCommitOptions = {
  /** Ticket/action identity of the user confirmation; the receipt must use it. */
  actionId?: string
  task?: { taskId: string; runId: string } | null
  /** Trusted check re-run after the native dialog and immediately before writing. */
  assertCurrent?: () => void
}
export async function exportItems(db: R1Database, input: ItemExportInput, scope: () => string,
  choose: (name: string, extension: string) => Promise<string | null>, options: ExportCommitOptions = {}) {
  if (!input || !['txt', 'md'].includes(input.format) || !Array.isArray(input.items) ||
    !input.items.length || input.items.length > 50 || input.items.some(row => !row || typeof row.itemId !== 'string' ||
      !Number.isSafeInteger(row.expectedVersion) || row.expectedVersion < 1) ||
    new Set(input.items.map(row => row.itemId)).size !== input.items.length) throw new Error('INVALID_EXPORT_INPUT')
  const items = new R1Items(db), owner = scope(), assertCurrent = options.assertCurrent ?? (() => undefined)
  const snapshots = input.items.map(row => {
    const item = items.toolView(row.itemId)
    if (item.version !== row.expectedVersion) throw new Error('VERSION_CONFLICT')
    return item
  })
  const name = (snapshots.length === 1 ? snapshots[0].title : 'Seamo事项')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_') || 'Seamo事项'
  const path = await choose(`${name}.${input.format}`, input.format)
  if (!path) return { cancelled: true as const }
  // The dialog may outlive the conversation, mode, owner window or Task goal
  // that authorized it; the caller supplies the real current-state check.
  assertCurrent()
  if (scope() !== owner) throw new Error('SESSION_CHANGED')
  for (const item of snapshots) if (items.toolView(item.itemId).version !== item.version) throw new Error('VERSION_CONFLICT')
  assertCurrent()
  const content = snapshots.map(item => {
    const state = item.type === 'todo' ? `${item.completed ? '[x]' : '[ ]'} ` : ''
    return `${input.format === 'md' ? '# ' : ''}${state}${item.title}\n\n${item.content}\n`
  }).join('\n')
  // No await between the final checks and write: the confirmed snapshot cannot be replaced by a renderer edit.
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 })
  const data = { path, format: input.format, itemVersions: snapshots.map(item => ({ itemId: item.itemId, version: item.version })),
    artifactId: null, artifactVersion: null, byteCount: Buffer.byteLength(content) }
  const actionId = options.actionId ?? randomUUID()
  const receipt = { kind: 'receipt' as const, actionId, tool: 'notes.export', status: 'succeeded' as const,
    entityId: null, entityVersion: null, data, errorCode: null, retryable: false, runId: options.task?.runId ?? null }
  // A file already written must never be paired with a silently reused/overwritten receipt.
  if (db.prepare('SELECT 1 FROM receipts WHERE action_id = ?').get(actionId)) throw new Error('EXPORT_FILE_WRITTEN_RECEIPT_FAILED')
  try {
    db.prepare(`INSERT INTO receipts(action_id, task_id, run_id, status, actual_result_json, created_at)
      VALUES(?,?,?,?,?,?)`).run(actionId, options.task?.taskId ?? null, options.task?.runId ?? null,
      receipt.status, JSON.stringify(receipt), new Date().toISOString())
  } catch { throw new Error('EXPORT_FILE_WRITTEN_RECEIPT_FAILED') }
  return { cancelled: false as const, ...data, receipt }
}
