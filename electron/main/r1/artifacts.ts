import { randomUUID } from 'node:crypto'
import { inTransaction, type R1Database } from './database.js'
import { R1Items, runOnce } from './items.js'

export type ArtifactDraft = { kind: 'text' | 'plan' | 'comparison'; title: string; content: string;
  baseArtifactId: string | null; baseArtifactVersion: number | null; sourceRefs: string[] }
export type Artifact = { artifactId: string; version: number; sourceTurnId: string; kind: ArtifactDraft['kind'];
  title: string; content: string; sourceRefs: string[]; savedItemId: string | null; temporary: boolean }
export type ArtifactRange = { start: number; end: number }
type Metadata = { kind: ArtifactDraft['kind']; title: string; sourceRefs: string[] }
type Row = { artifact_id: string; current_version: number; source_turn_id: string; saved_item_id: string | null }
type VersionRow = { version: number; body: string; metadata_json: string; base_version: number | null }
type TemporaryArtifact = { owner: string; versions: Artifact[] }
const text = (value: unknown, max: number, code: string): string => {
  if (typeof value !== 'string' || !value.trim() || [...value].length > max) throw new Error(code)
  return value
}
function metadata(input: Pick<ArtifactDraft, 'kind' | 'title' | 'content' | 'sourceRefs'>): Metadata {
  if (!['text', 'plan', 'comparison'].includes(input.kind)) throw new Error('ARTIFACT_KIND_INVALID')
  text(input.title, 80, 'ARTIFACT_TITLE_INVALID'); text(input.content, 8000, 'ARTIFACT_CONTENT_INVALID')
  if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length > 50 ||
    new Set(input.sourceRefs).size !== input.sourceRefs.length || input.sourceRefs.some(ref =>
      typeof ref !== 'string' || !ref || [...ref].length > 160)) throw new Error('ARTIFACT_REFERENCES_INVALID')
  return { kind: input.kind, title: input.title, sourceRefs: [...input.sourceRefs] }
}

export class R1Artifacts {
  private readonly temporary = new Map<string, TemporaryArtifact>()
  constructor(private readonly db: R1Database) {}
  /** Publication of multiple temporary versions must roll back as one operation. */
  inTemporaryTransaction<T>(owner: string, run: () => T): T {
    const previous = structuredClone([...this.temporary].filter(([, artifact]) => artifact.owner === owner))
    try { return run() } catch (error) {
      this.endTemporary(owner)
      for (const [id, artifact] of previous) this.temporary.set(id, artifact)
      throw error
    }
  }
  validateDraft(draft: ArtifactDraft): void {
    const meta = metadata(draft); this.assertSources(meta.sourceRefs)
    if ((draft.baseArtifactId === null) !== (draft.baseArtifactVersion === null)) throw new Error('ARTIFACT_BASE_INVALID')
  }
  private assertSources(refs: string[]): void {
    if (refs.some(ref => Boolean(this.db.prepare('SELECT 1 FROM source_suppression WHERE source_ref = ?').get(ref)))) {
      throw new Error('ARTIFACT_SOURCE_SUPPRESSED')
    }
  }
  get(artifactId: string, temporaryOwner: string | null = null, version?: number): Artifact {
    text(artifactId, 160, 'ARTIFACT_ID_INVALID')
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new Error('ARTIFACT_VERSION_INVALID')
    const temp = this.temporary.get(artifactId)
    if (temp) {
      if (temporaryOwner !== temp.owner) throw new Error('ARTIFACT_NOT_FOUND')
      const result = version ? temp.versions.find(item => item.version === version) : temp.versions.at(-1)
      if (!result) throw new Error('ARTIFACT_NOT_FOUND')
      this.assertSources(result.sourceRefs)
      return structuredClone(result)
    }
    if (temporaryOwner) throw new Error('TEMPORARY_ARTIFACT_SCOPE_INVALID')
    const row = this.db.prepare('SELECT * FROM artifacts WHERE artifact_id = ?').get(artifactId) as Row | undefined
    if (!row) throw new Error('ARTIFACT_NOT_FOUND')
    const value = this.db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?')
      .get(artifactId, version ?? row.current_version) as VersionRow | undefined
    if (!value) throw new Error('ARTIFACT_NOT_FOUND')
    const data = JSON.parse(value.metadata_json) as Partial<Metadata>
    const meta = metadata({ kind: data.kind ?? 'text', title: data.title ?? '工作稿',
      sourceRefs: data.sourceRefs ?? [], content: value.body })
    this.assertSources(meta.sourceRefs)
    return { artifactId, sourceTurnId: row.source_turn_id, savedItemId: row.saved_item_id,
      version: value.version, content: value.body, ...meta, temporary: false }
  }
  create(input: { sourceTurnId: string; draft: ArtifactDraft; temporaryOwner?: string | null }): Artifact {
    text(input.sourceTurnId, 160, 'ARTIFACT_SOURCE_REQUIRED')
    if (input.draft.baseArtifactId !== null || input.draft.baseArtifactVersion !== null) throw new Error('ARTIFACT_BASE_INVALID')
    const meta = metadata(input.draft)
    this.assertSources(meta.sourceRefs)
    const result: Artifact = { artifactId: randomUUID(), version: 1, sourceTurnId: input.sourceTurnId,
      ...meta, content: input.draft.content, savedItemId: null, temporary: !!input.temporaryOwner }
    if (input.temporaryOwner) {
      text(input.temporaryOwner, 160, 'ARTIFACT_OWNER_INVALID')
      this.temporary.set(result.artifactId, { owner: input.temporaryOwner, versions: [result] })
      return structuredClone(result)
    }
    return inTransaction(this.db, () => {
      const now = new Date().toISOString()
      this.db.prepare(`INSERT INTO artifacts (artifact_id, source_turn_id, current_version, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?)`).run(result.artifactId, result.sourceTurnId, now, now)
      this.db.prepare(`INSERT INTO artifact_versions (artifact_id, version, body, metadata_json, created_at)
        VALUES (?, 1, ?, ?, ?)`).run(result.artifactId, result.content, JSON.stringify(meta), now)
      return structuredClone(result)
    })
  }
  revise(input: { artifactId: string; expectedVersion: number; content: string; target?: ArtifactRange | null;
    title?: string; temporaryOwner?: string | null }): Artifact {
    const current = this.get(input.artifactId, input.temporaryOwner ?? null)
    if (current.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
    const content = text(input.content, 8000, 'ARTIFACT_CONTENT_INVALID')
    const meta = metadata({ ...current, title: input.title ?? current.title, content })
    if (input.target) {
      const chars = [...current.content]
      const { start, end } = input.target
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > chars.length) {
        throw new Error('ARTIFACT_RANGE_INVALID')
      }
      const prefix = chars.slice(0, start).join(''); const suffix = chars.slice(end).join('')
      if (!content.startsWith(prefix) || !content.endsWith(suffix) || [...content].length < [...prefix, ...suffix].length) {
        throw new Error('ARTIFACT_OUTSIDE_TARGET_CHANGED')
      }
    }
    const updated = { ...current, ...meta, content, version: current.version + 1 }
    if (current.temporary) {
      this.temporary.get(current.artifactId)!.versions.push(updated)
      return structuredClone(updated)
    }
    return inTransaction(this.db, () => {
      const now = new Date().toISOString()
      const change = this.db.prepare(`UPDATE artifacts SET current_version = ?, updated_at = ?
        WHERE artifact_id = ? AND current_version = ?`).run(updated.version, now, updated.artifactId, current.version)
      if (!change.changes) throw new Error('VERSION_CONFLICT')
      this.db.prepare(`INSERT INTO artifact_versions
        (artifact_id, version, base_version, body, target_ref, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(updated.artifactId, updated.version, current.version, updated.content,
          input.target ? JSON.stringify(input.target) : null, JSON.stringify(meta), now)
      return structuredClone(updated)
    })
  }
  undo(input: { artifactId: string; expectedVersion: number; restoreVersion: number; temporaryOwner?: string | null }): Artifact {
    if (!Number.isSafeInteger(input.restoreVersion) || input.restoreVersion < 1 ||
      !Number.isSafeInteger(input.expectedVersion) || input.restoreVersion >= input.expectedVersion) throw new Error('ARTIFACT_UNDO_INVALID')
    const old = this.get(input.artifactId, input.temporaryOwner ?? null, input.restoreVersion)
    return this.revise({ ...input, content: old.content, title: old.title })
  }
  save(input: { artifactId: string; expectedVersion: number; actionId: string;
    expectedItemVersion?: number; temporaryOwner?: string | null; temporarySaveConfirmed?: boolean }):
    ReturnType<R1Items['create']> {
    const artifact = this.get(input.artifactId, input.temporaryOwner ?? null)
    if (artifact.temporary && input.temporarySaveConfirmed !== true) throw new Error('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
    const result = runOnce(this.db, input.actionId, input, () => {
      if (artifact.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
      const items = new R1Items(this.db)
      const saved = artifact.savedItemId ? this.db.prepare('SELECT kind FROM items WHERE item_id = ? AND deleted_at IS NULL')
        .get(artifact.savedItemId) as { kind: 'note' | 'todo' } | undefined : undefined
      if (artifact.savedItemId && !saved) throw new Error('ITEM_NOT_FOUND')
      const itemActionId = randomUUID()
      const result = artifact.savedItemId
        ? items.update({ actionId: itemActionId, itemId: artifact.savedItemId, expectedVersion: input.expectedItemVersion!, kind: saved!.kind,
          title: artifact.title, body: artifact.content })
        : items.create({ actionId: itemActionId, kind: 'note', title: artifact.title, body: artifact.content })
      if (!artifact.temporary) this.db.prepare('UPDATE artifacts SET saved_item_id = ?, updated_at = ? WHERE artifact_id = ?')
        .run(result.item.itemId, new Date().toISOString(), artifact.artifactId)
      return { item: result.item, receipt: { ...result.receipt, actionId: input.actionId } }
    })
    if (artifact.temporary) {
      for (const version of this.temporary.get(artifact.artifactId)!.versions) version.savedItemId = result.item.itemId
    }
    return result
  }
  endTemporary(owner: string): void {
    for (const [id, artifact] of this.temporary) if (artifact.owner === owner) this.temporary.delete(id)
  }
}
