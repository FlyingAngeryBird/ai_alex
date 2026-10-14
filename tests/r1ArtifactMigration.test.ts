import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { openR1Database, R1_SCHEMA_VERSION } from '../electron/main/r1/database'
import { R1Artifacts } from '../electron/main/r1/artifacts'
describe('R1 artifact metadata and saved baseline migration', () => {
  it('preserves v4 linked records and leaves unknown saved versions for explicit review', () => {
    const directory = mkdtempSync(join(tmpdir(), 'seamo-artifact-v5-'))
    const path = join(directory, 'r1.sqlite')
    let db = openR1Database(path)
    try {
      const store = new R1Artifacts(db)
      const artifact = store.create({ sourceTurnId: 'source', draft: { kind: 'text', title: 'linked',
        content: 'linked body', sourceRefs: [], baseArtifactId: null, baseArtifactVersion: null } })
      const saved = store.save({ artifactId: artifact.artifactId, expectedVersion: 1, actionId: 'save-old' })
      db.exec('ALTER TABLE artifacts DROP COLUMN saved_item_version')
      db.exec('PRAGMA user_version = 4')
      db.close(); db = openR1Database(path)
      const migrated = new R1Artifacts(db)
      expect(migrated.get(artifact.artifactId)).toMatchObject({ savedItemId: saved.item.itemId, savedItemVersion: null })
      expect(() => migrated.save({ artifactId: artifact.artifactId, expectedVersion: 1,
        expectedItemVersion: 1, actionId: 'blind' })).toThrow('VERSION_CONFLICT')
      expect(migrated.save({ artifactId: artifact.artifactId, expectedVersion: 1,
        expectedItemVersion: 1, actionId: 'reviewed', replacementConfirmed: true }).item.itemId).toBe(saved.item.itemId)
      const snapshots = readdirSync(directory).filter(name => name.includes(`.pre-schema-4-to-${R1_SCHEMA_VERSION}-`))
      expect(snapshots).toHaveLength(1)
      const previous = new DatabaseSync(join(directory, snapshots[0]), { readOnly: true })
      try {
        expect(previous.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 4 })
        expect(previous.prepare('SELECT body FROM items').get()).toMatchObject({ body: 'linked body' })
      } finally { previous.close() }
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  it('preserves v3 bodies and versions without inventing provenance', () => {
    const directory = mkdtempSync(join(tmpdir(), 'seamo-artifact-migration-'))
    const path = join(directory, 'r1.sqlite')
    let db = openR1Database(path)
    try {
      const artifact = new R1Artifacts(db).create({ sourceTurnId: 'source', draft: { kind: 'text', title: 'old title',
        content: 'original body', sourceRefs: [], baseArtifactId: null, baseArtifactVersion: null } })
      db.exec('ALTER TABLE artifact_versions DROP COLUMN metadata_json')
      db.exec('PRAGMA user_version = 3')
      db.close(); db = openR1Database(path)
      expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: R1_SCHEMA_VERSION })
      expect(new R1Artifacts(db).get(artifact.artifactId)).toMatchObject({ version: 1, content: 'original body',
        sourceRefs: [], title: '工作稿' })
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_versions').get()).toMatchObject({ n: 1 })
      const snapshots = readdirSync(directory).filter(name => name.includes(`.pre-schema-3-to-${R1_SCHEMA_VERSION}-`))
      expect(snapshots).toHaveLength(1)
      expect(statSync(join(directory, snapshots[0])).mode & 0o777).toBe(0o600)
      const previous = new DatabaseSync(join(directory, snapshots[0]), { readOnly: true })
      try {
        expect(previous.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 })
        expect(previous.prepare('SELECT body FROM artifact_versions').get()).toMatchObject({ body: 'original body' })
      } finally { previous.close() }
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
  })
})
