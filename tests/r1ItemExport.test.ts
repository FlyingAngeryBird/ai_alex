import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openR1Database } from '../electron/main/r1/database'
import { R1Items } from '../electron/main/r1/items'
import { exportItems } from '../electron/main/r1/itemExport'
it('exports the confirmed real Item versions to TXT/MD with actual receipts and keeps data on cancellation/conflict/failure', async () => {
 const db = openR1Database(':memory:'), items = new R1Items(db), folder = await mkdtemp(join(tmpdir(), 'seamo-item-export-'))
 const item = items.create({ actionId: 'seed', kind: 'todo', title: '购物', body: '茶\n燕麦奶🙂' }).item
 const input = { items: [{ itemId: item.itemId, expectedVersion: 1 }], format: 'md' as const }
 try {
  for (const format of ['txt', 'md'] as const) {
   const path = join(folder, `item.${format}`), result = await exportItems(db, { ...input, format }, () => 'session', async () => path)
   expect(result).toMatchObject({ cancelled: false, itemVersions: [{ itemId: item.itemId, version: 1 }], receipt: { tool: 'notes.export', status: 'succeeded' } })
   const text = await readFile(path, 'utf8')
   expect(text).toBe(`${format === 'md' ? '# ' : ''}[ ] 购物\n\n茶\n燕麦奶🙂\n`)
   if (!result.cancelled) expect(result.byteCount).toBe(Buffer.byteLength(text))
  }
  expect(await exportItems(db, input, () => 'session', async () => null)).toEqual({ cancelled: true })
  expect(db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE actual_result_json LIKE '%notes.export%'").get()).toMatchObject({ n: 2 })
  const conflictPath = join(folder, 'conflict.md')
  await expect(exportItems(db, input, () => 'session', async () => {
   items.update({ actionId: 'page', itemId: item.itemId, expectedVersion: 1, title: item.title, kind: 'todo', body: '页面新版本' }); return conflictPath
  })).rejects.toThrow('VERSION_CONFLICT')
  await expect(readFile(conflictPath)).rejects.toThrow()
  const latest = { ...input, items: [{ itemId: item.itemId, expectedVersion: 2 }] }
  await expect(exportItems(db, latest, () => 'session', async () => join(folder, 'missing', 'item.md'))).rejects.toThrow()
  expect(items.toolView(item.itemId)).toMatchObject({ version: 2, content: '页面新版本' })
  let scope = 'session'
  await expect(exportItems(db, latest, () => scope, async () => { scope = 'other'; return join(folder, 'scope.md') })).rejects.toThrow('SESSION_CHANGED')
  expect(items.list()).toHaveLength(1)
 } finally { db.close(); await rm(folder, { recursive: true }) }
})
