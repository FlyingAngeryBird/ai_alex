import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { R1Artifacts, type ArtifactDraft } from '../electron/main/r1/artifacts'
import { inTransaction, openR1Database } from '../electron/main/r1/database'
import { R1Items } from '../electron/main/r1/items'
const draft = (content = '第一段🙂\n\n第二段\n\n第三段'): ArtifactDraft => ({ kind: 'text', title: '讨论稿',
  content, baseArtifactId: null, baseArtifactVersion: null, sourceRefs: [] })
describe('versioned R1 artifacts', () => {
  it('preserves versions across restart and rejects stale edits; undo creates a new revision', () => {
    const directory = mkdtempSync(join(tmpdir(), 'seamo-artifact-'))
    const path = join(directory, 'r1.sqlite')
    let db = openR1Database(path)
    try {
      let store = new R1Artifacts(db)
      const first = store.create({ sourceTurnId: 'source', draft: draft() })
      const second = store.revise({ artifactId: first.artifactId, expectedVersion: 1, content: '手动编辑' })
      expect(() => store.revise({ artifactId: first.artifactId, expectedVersion: 1, content: '旧模型回复' })).toThrow('VERSION_CONFLICT')
      db.close(); db = openR1Database(path); store = new R1Artifacts(db)
      expect(store.get(first.artifactId).content).toBe('手动编辑')
      expect(store.get(first.artifactId, null, 1).content).toBe(first.content)
      const third = store.undo({ artifactId: first.artifactId, expectedVersion: second.version, restoreVersion: 1 })
      expect(third).toMatchObject({ version: 3, content: first.content })
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
  })
  it('uses codepoint ranges and rejects model changes outside the selected paragraph', () => {
    const db = openR1Database(':memory:')
    try {
      const store = new R1Artifacts(db)
      const first = store.create({ sourceTurnId: 'source', draft: draft() })
      const start = [...'第一段🙂\n\n'].length
      const target = { start, end: start + [...'第二段'].length }
      expect(() => store.revise({ artifactId: first.artifactId, expectedVersion: 1, target,
        content: '第一段被模型改了\n\n更短\n\n第三段' })).toThrow('ARTIFACT_OUTSIDE_TARGET_CHANGED')
      expect(store.revise({ artifactId: first.artifactId, expectedVersion: 1, target,
        content: '第一段🙂\n\n更短\n\n第三段' }).version).toBe(2)
    } finally { db.close() }
  })
  it('saves once, updates the same note explicitly, and never syncs later draft edits automatically', () => {
    const db = openR1Database(':memory:')
    try {
      const store = new R1Artifacts(db)
      const first = store.create({ sourceTurnId: 'source', draft: draft('正文 v1') })
      const command = { artifactId: first.artifactId, expectedVersion: 1, actionId: 'save-1' }
      const saved = store.save(command)
      expect(store.save(command)).toEqual(saved)
      expect(new R1Items(db).list()).toHaveLength(1)
      store.revise({ artifactId: first.artifactId, expectedVersion: 1, content: '正文 v2' })
      expect(new R1Items(db).list()[0].body).toBe('正文 v1')
      const next = store.save({ ...command, expectedVersion: 2, actionId: 'save-2', expectedItemVersion: 1 })
      expect(next.item).toMatchObject({ itemId: saved.item.itemId, version: 2, body: '正文 v2' })
      expect(new R1Items(db).list()).toHaveLength(1)
      new R1Items(db).update({ actionId: 'external', itemId: saved.item.itemId, expectedVersion: 2,
        kind: 'note', title: '用户修改的事项', body: '不能被旧保存覆盖' })
      expect(() => store.save({ ...command, expectedVersion: 2, actionId: 'save-3', expectedItemVersion: 2 })).toThrow('VERSION_CONFLICT')
    } finally { db.close() }
  })
  it('keeps temporary drafts in memory, requires explicit save, and preserves the saved item on temporary exit', () => {
    const db = openR1Database(':memory:')
    try {
      const store = new R1Artifacts(db)
      const first = store.create({ sourceTurnId: 'temp-source', draft: draft('临时正文'), temporaryOwner: 'temp-session' })
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toMatchObject({ n: 0 })
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_versions').get()).toMatchObject({ n: 0 })
      expect(() => store.get(first.artifactId)).toThrow('ARTIFACT_NOT_FOUND')
      expect(() => store.save({ artifactId: first.artifactId, expectedVersion: 1, actionId: 'save', temporaryOwner: 'temp-session' }))
        .toThrow('TEMPORARY_SAVE_CONFIRMATION_REQUIRED')
      const saved = store.save({ artifactId: first.artifactId, expectedVersion: 1, actionId: 'confirmed',
        temporaryOwner: 'temp-session', temporarySaveConfirmed: true })
      store.endTemporary('temp-session')
      expect(() => store.get(first.artifactId, 'temp-session')).toThrow('TEMPORARY_ARTIFACT_SCOPE_INVALID')
      expect(new R1Items(db).list()[0].itemId).toBe(saved.item.itemId)
    } finally { db.close() }
  })
  it('rolls back a nested publication/save and blocks artifacts whose sources were forgotten', () => {
    const db = openR1Database(':memory:')
    try {
      const store = new R1Artifacts(db)
      expect(() => inTransaction(db, () => {
        const first = store.create({ sourceTurnId: 'source', draft: draft() })
        store.save({ artifactId: first.artifactId, expectedVersion: 1, actionId: 'save' })
        throw new Error('publication-failed')
      })).toThrow('publication-failed')
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toMatchObject({ n: 0 })
      expect(new R1Items(db).list()).toEqual([])
      expect(db.prepare('SELECT COUNT(*) AS n FROM receipts').get()).toMatchObject({ n: 0 })
      const first = store.create({ sourceTurnId: 'source', draft: { ...draft(), sourceRefs: ['memory-source'] } })
      db.prepare('INSERT INTO source_suppression VALUES (?, 1, ?)').run('memory-source', new Date().toISOString())
      expect(() => store.get(first.artifactId)).toThrow('ARTIFACT_SOURCE_SUPPRESSED')
      expect(() => store.undo({ artifactId: first.artifactId, expectedVersion: 1, restoreVersion: 1 })).toThrow('ARTIFACT_UNDO_INVALID')
    } finally { db.close() }
  })
  it('rolls back temporary multi-artifact publication without changing another session', () => {
    const db = openR1Database(':memory:')
    try {
      const store = new R1Artifacts(db)
      const old = store.create({ sourceTurnId: 'temp', draft: draft('保留版本'), temporaryOwner: 'owner' })
      const other = store.create({ sourceTurnId: 'other', draft: draft('另一会话'), temporaryOwner: 'other-owner' })
      let newId = ''
      expect(() => store.inTemporaryTransaction('owner', () => {
        store.revise({ artifactId: old.artifactId, expectedVersion: 1, content: '未完成发布', temporaryOwner: 'owner' })
        newId = store.create({ sourceTurnId: 'temp', draft: draft('第二份稿件'), temporaryOwner: 'owner' }).artifactId
        throw new Error('publication-failed')
      })).toThrow('publication-failed')
      expect(store.get(old.artifactId, 'owner')).toMatchObject({ version: 1, content: '保留版本' })
      expect(() => store.get(newId, 'owner')).toThrow('TEMPORARY_ARTIFACT_SCOPE_INVALID')
      expect(store.get(other.artifactId, 'other-owner').content).toBe('另一会话')
      expect(db.prepare('SELECT COUNT(*) AS n FROM artifact_versions').get()).toMatchObject({ n: 0 })
    } finally { db.close() }
  })
})
