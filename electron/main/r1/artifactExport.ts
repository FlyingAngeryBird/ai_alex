import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { R1Artifacts } from './artifacts.js'
import type { R1Database } from './database.js'
export type ArtifactExportInput = { artifactId: string; expectedVersion: number; format: 'txt' | 'md' }
export type ArtifactExportOptions = {
  db?: R1Database
  actionId?: string
  task?: { taskId: string; runId: string } | null
  /** Trusted check re-run after the native dialog and immediately before writing. */
  assertCurrent?: () => void
}
export function artifactExportContent(title: string, content: string, format: 'txt' | 'md'): string {
  const firstNonEmptyLine = content.split(/\r?\n/).find(line => line.trim() !== '')
  const heading = firstNonEmptyLine?.match(/^#\s+(.+?)\s*$/)
  // Keep a body that already starts with the same H1; never duplicate the title for txt/md.
  if (heading && heading[1].trim() === title.trim()) return content.endsWith('\n') ? content : `${content}\n`
  return `${format === 'md' ? '# ' : ''}${title}\n\n${content}\n`
}

export async function exportArtifact(artifacts: R1Artifacts, input: ArtifactExportInput,
  owner: () => string | null, choose: (name: string, extension: string) => Promise<string | null>,
  options: ArtifactExportOptions = {}) {
  if (!input || !['txt', 'md'].includes(input.format) || !Number.isSafeInteger(input.expectedVersion)) throw new Error('INVALID_EXPORT_INPUT')
  const scope = owner(), assertCurrent = options.assertCurrent ?? (() => undefined)
  const snapshot = artifacts.get(input.artifactId, scope)
  if (snapshot.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
  const name = snapshot.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_') || '工作稿'
  const path = await choose(`${name}.${input.format}`, input.format)
  if (!path) return { cancelled: true as const }
  // The dialog may outlive the conversation/mode or the Task that authorized it.
  assertCurrent()
  if (owner() !== scope) throw new Error('SESSION_CHANGED')
  // Recheck access and version after the native dialog returns; never substitute newer text.
  const current = artifacts.get(input.artifactId, scope)
  if (current.version !== snapshot.version) throw new Error('VERSION_CONFLICT')
  assertCurrent()
  const content = artifactExportContent(snapshot.title, snapshot.content, input.format)
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 })
  if (!options.db) return { cancelled: false as const, artifactId: snapshot.artifactId, version: snapshot.version, path }
  const data = { path, format: input.format, itemVersions: [] as { itemId: string; version: number }[],
    artifactId: snapshot.artifactId, artifactVersion: snapshot.version, byteCount: Buffer.byteLength(content) }
  const actionId = options.actionId ?? randomUUID()
  const receipt = { kind: 'receipt' as const, actionId, tool: 'notes.export', status: 'succeeded' as const,
    entityId: snapshot.artifactId, entityVersion: snapshot.version, data, errorCode: null, retryable: false,
    runId: options.task?.runId ?? null }
  // The file is already written: a failed/duplicated receipt must be reported, never retried by rewriting.
  if (options.db.prepare('SELECT 1 FROM receipts WHERE action_id = ?').get(actionId)) throw new Error('EXPORT_FILE_WRITTEN_RECEIPT_FAILED')
  try {
    options.db.prepare(`INSERT INTO receipts(action_id, task_id, run_id, status, actual_result_json, created_at)
      VALUES(?,?,?,?,?,?)`).run(actionId, options.task?.taskId ?? null, options.task?.runId ?? null,
      receipt.status, JSON.stringify(receipt), new Date().toISOString())
  } catch { throw new Error('EXPORT_FILE_WRITTEN_RECEIPT_FAILED') }
  return { cancelled: false as const, ...data, version: snapshot.version, receipt }
}
