import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { openR1Database, R1_SCHEMA_VERSION } from '../electron/main/r1/database'
import { R1Artifacts } from '../electron/main/r1/artifacts'
describe('R1 artifact metadata v4 migration', () => {
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
      const snapshots = readdirSync(directory).filter(name => name.includes('.pre-schema-3-to-4-'))
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
