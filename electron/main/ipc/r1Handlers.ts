import { ipcMain, dialog } from 'electron'
import { exportItems, type ItemExportInput } from '../r1/itemExport.js'
import { R1Items } from '../r1/items.js'
import { R1PersonaStore } from '../r1/persona.js'
import { R1MemoryStore } from '../r1/memory.js'
import { R1Conversations } from '../r1/conversations.js'
import type { R1SessionMode } from '../r1/sessionMode.js'
import type { R1Database } from '../r1/database.js'

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR'
  return { ok: false as const, error: { code: message, message } }
}

function action<T>(run: (payload: T) => unknown) {
  return (_event: unknown, payload?: unknown) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return failure(new Error('INVALID_PAYLOAD'))
    try { return { ok: true as const, data: run(payload as T) } } catch (error) { return failure(error) }
  }
}

export function registerR1Handlers(db: R1Database, ipc: IpcMainLike = ipcMain,
  sessionMode: R1SessionMode = { temporary: false },
  onMemoryInvalidated: (deletionEpoch: number) => void = () => undefined): void {
  const items = new R1Items(db)
  const persona = new R1PersonaStore(db)
  const memory = new R1MemoryStore(db)
  const history = new R1Conversations(db)
  const notifyInvalidation = () => {
    try { onMemoryInvalidated(memory.currentDeletionEpoch()) } catch { /* Commit remains successful. */ }
  }
  ipc.handle('r1.persona.get', () => ({ ok: true, data: persona.get() }))
  ipc.handle('r1.persona.update', action<Parameters<R1PersonaStore['update']>[0]>((payload) => persona.update(payload)))
  const requireNormal = () => {
    if (sessionMode.temporary) throw new Error('MEMORY_UNAVAILABLE_IN_TEMPORARY_SESSION')
  }
  ipc.handle('r1.memory.list', (_event, payload) => {
    try {
      requireNormal()
      if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload))) {
        throw new Error('INVALID_MEMORY_QUERY')
      }
      return { ok: true, data: memory.list(payload as Parameters<R1MemoryStore['list']>[0]) }
    } catch (error) { return failure(error) }
  })
  ipc.handle('r1.memory.addManual', action<Parameters<R1MemoryStore['addManual']>[0]>((payload) =>
    { requireNormal(); return memory.addManual(payload) }))
  ipc.handle('r1.memory.update', action<Parameters<R1MemoryStore['update']>[0]>((payload) =>
    { requireNormal(); const result = memory.update(payload); notifyInvalidation(); return result }))
  ipc.handle('r1.memory.sources', action<{ memoryId: string }>((payload) =>
    { requireNormal(); return memory.sources(payload.memoryId) }))
  ipc.handle('r1.memory.forget', action<{ memoryId: string; expectedVersion: number }>((payload) =>
    { requireNormal(); const result = memory.forget(payload.memoryId, payload.expectedVersion); notifyInvalidation(); return result }))
  ipc.handle('r1.history.list', (_event, payload) => {
    try {
      if (sessionMode.temporary) throw new Error('HISTORY_UNAVAILABLE_IN_TEMPORARY_SESSION')
      if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload))) {
        throw new Error('INVALID_HISTORY_QUERY')
      }
      return { ok: true, data: history.history(payload as Parameters<R1Conversations['history']>[0]) }
    } catch (error) { return failure(error) }
  })
  ipc.handle('r1.history.messages', action<{ sessionId: string }>((payload) =>
    { if (sessionMode.temporary) throw new Error('HISTORY_UNAVAILABLE_IN_TEMPORARY_SESSION')
      return history.messages(payload.sessionId) }))
  ipc.handle('r1.session.temporaryPersistence', (_event, payload) => {
    try {
      if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        typeof (payload as { confirmed?: unknown }).confirmed !== 'boolean')) throw new Error('INVALID_TEMPORARY_PERSISTENCE')
      if (payload) sessionMode.temporaryPersistenceConfirmed = (payload as { confirmed: boolean }).confirmed
      return { ok: true, data: { confirmed: sessionMode.temporary === true && sessionMode.temporaryPersistenceConfirmed === true } }
    } catch (error) { return failure(error) }
  })
  ipc.handle('r1.items.list', () => ({ ok: true, data: items.list() }))
  ipc.handle('r1.items.export', async (_event, payload) => {
    try {
      const data = await exportItems(db, payload as ItemExportInput,
        () => JSON.stringify([sessionMode.temporary, sessionMode.sessionId]), async (name, extension) => {
          const selected = await dialog.showSaveDialog({ defaultPath: name,
            filters: [{ name: extension === 'md' ? 'Markdown' : '纯文本', extensions: [extension] }] })
          return selected.canceled ? null : selected.filePath ?? null
        })
      return { ok: true, data }
    } catch (error) { return failure(error) }
  })
  ipc.handle('r1.items.create', action<Parameters<R1Items['create']>[0]>((payload) => items.create(payload)))
  ipc.handle('r1.items.update', action<Parameters<R1Items['update']>[0]>((payload) => items.update(payload)))
  ipc.handle('r1.items.complete', action<Parameters<R1Items['complete']>[0]>((payload) => items.complete(payload)))
  ipc.handle('r1.items.deletionPreview', action<{ itemId: string }>((payload) => items.deletionPreview(payload.itemId)))
  ipc.handle('r1.items.delete', action<Parameters<R1Items['delete']>[0]>((payload) => items.delete(payload)))
  ipc.handle('r1.reminders.list', () => ({ ok: true, data: items.listReminders() }))
  ipc.handle('r1.reminders.create', action<Parameters<R1Items['createReminder']>[0]>((payload) => items.createReminder(payload)))
  ipc.handle('r1.reminders.reschedule', action<Parameters<R1Items['reschedule']>[0]>((payload) => items.reschedule(payload)))
  ipc.handle('r1.reminders.cancel', action<Parameters<R1Items['cancelReminder']>[0]>((payload) => items.cancelReminder(payload)))
}
