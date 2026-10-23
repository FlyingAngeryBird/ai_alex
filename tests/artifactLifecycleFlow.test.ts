import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Artifacts } from '../electron/main/r1/artifacts'
import { exportArtifact } from '../electron/main/r1/artifactExport'

it('keeps one Artifact version chain through range revision, undo, save-to-Item and confirmed-version export', async () => {
  const db = openR1Database(':memory:')
  const artifacts = new R1Artifacts(db)
  const directory = mkdtempSync(join(tmpdir(), 'seamo-artifact-flow-'))
  try {
    const created = artifacts.create({ sourceTurnId: 'turn', draft: { kind: 'text', title: '讨论稿',
      content: 'Alpha\n\nBeta', baseArtifactId: null, baseArtifactVersion: null, sourceRefs: [] } })
    const revised = artifacts.revise({ artifactId: created.artifactId, expectedVersion: 1,
      content: 'Alpha\n\nGamma', target: { start: 7, end: 11 } })
    expect(revised).toMatchObject({ version: 2, content: 'Alpha\n\nGamma' })
    const undone = artifacts.undo({ artifactId: created.artifactId, expectedVersion: 2, restoreVersion: 1 })
    expect(undone).toMatchObject({ version: 3, content: 'Alpha\n\nBeta' })
    expect(() => artifacts.revise({ artifactId: created.artifactId, expectedVersion: 1, content: 'Alpha\n\nDelta' }))
      .toThrow('VERSION_CONFLICT')

    const firstSave = artifacts.save({ artifactId: created.artifactId, expectedVersion: 3, actionId: 'save-1', kind: 'note' })
    expect(firstSave.item).toMatchObject({ title: '讨论稿', body: 'Alpha\n\nBeta', version: 1 })
    const secondSave = artifacts.save({ artifactId: created.artifactId, expectedVersion: 3, actionId: 'save-2',
      expectedItemVersion: 1 })
    expect(secondSave.item).toMatchObject({ itemId: firstSave.item.itemId, version: 2 })

    const path = join(directory, 'artifact.md')
    const exported = await exportArtifact(artifacts, { artifactId: created.artifactId, expectedVersion: 3, format: 'md' },
      () => null, async () => path)
    expect(exported).toMatchObject({ cancelled: false, artifactId: created.artifactId, version: 3 })
    expect(readFileSync(path, 'utf8')).toBe('# 讨论稿\n\nAlpha\n\nBeta\n')
    await expect(exportArtifact(artifacts, { artifactId: created.artifactId, expectedVersion: 2, format: 'txt' },
      () => null, async () => join(directory, 'stale.txt'))).rejects.toThrow('VERSION_CONFLICT')
    expect(() => readFileSync(join(directory, 'stale.txt'))).toThrow()
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})
