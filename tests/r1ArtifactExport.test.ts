import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportArtifact } from '../electron/main/r1/artifactExport'
import { openR1Database } from '../electron/main/r1/database'
import { R1Artifacts } from '../electron/main/r1/artifacts'
it('writes the selected version and treats cancellation as cancellation', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'r1-export-'))
  const artifacts = { get: () => ({ artifactId: 'a', version: 2, title: '讨论稿', content: '第二版正文' }) } as unknown as R1Artifacts
  try {
    for (const format of ['txt', 'md'] as const) {
      const path = join(folder, `result.${format}`)
      expect(await exportArtifact(artifacts, { artifactId: 'a', expectedVersion: 2, format }, () => null, async () => path))
        .toMatchObject({ cancelled: false, version: 2, path })
      expect(await readFile(path, 'utf8')).toBe(`${format === 'md' ? '# ' : ''}讨论稿\n\n第二版正文\n`)
    }
    expect(await exportArtifact(artifacts, { artifactId: 'a', expectedVersion: 2, format: 'txt' }, () => null, async () => null))
      .toEqual({ cancelled: true })
    await expect(exportArtifact(artifacts, { artifactId: 'a', expectedVersion: 1, format: 'txt' }, () => null, async () => join(folder, 'old.txt')))
      .rejects.toThrow('VERSION_CONFLICT')
  } finally { await rm(folder, { recursive: true }) }
})
it('rejects a scope change while the native save dialog is open', async () => {
  let owner: string | null = null
  const artifacts = { get: () => ({ artifactId: 'a', version: 1, title: '稿件', content: '正文' }) } as unknown as R1Artifacts
  await expect(exportArtifact(artifacts, { artifactId: 'a', expectedVersion: 1, format: 'txt' }, () => owner,
    async () => { owner = 'temporary'; return '/unused.txt' })).rejects.toThrow('SESSION_CHANGED')
})

it('exports real SQLite revisions, rejects a concurrent revision and preserves the draft on write failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'r1-export-db-'))
  const db = openR1Database(':memory:')
  const artifacts = new R1Artifacts(db)
  try {
    const first = artifacts.create({ sourceTurnId: 'test-turn', draft: { kind: 'text', title: '版本检查',
      content: '第一版', sourceRefs: [], baseArtifactId: null, baseArtifactVersion: null } })
    const input = { artifactId: first.artifactId, expectedVersion: 1, format: 'txt' as const }
    const output = join(directory, 'draft.txt')
    await expect(exportArtifact(artifacts, input, () => null, async () => {
      artifacts.revise({ artifactId: first.artifactId, expectedVersion: 1, content: '第二版🙂' })
      return output
    })).rejects.toThrow('VERSION_CONFLICT')
    await expect(readFile(output)).rejects.toThrow()
    await exportArtifact(artifacts, { ...input, expectedVersion: 2 }, () => null, async () => output)
    expect(await readFile(output, 'utf8')).toBe('版本检查\n\n第二版🙂\n')
    await expect(exportArtifact(artifacts, { ...input, expectedVersion: 2 }, () => null,
      async () => join(directory, 'missing', 'draft.txt'))).rejects.toThrow()
    expect(artifacts.get(first.artifactId)).toMatchObject({ version: 2, content: '第二版🙂' })
  } finally { db.close(); await rm(directory, { recursive: true }) }
})
