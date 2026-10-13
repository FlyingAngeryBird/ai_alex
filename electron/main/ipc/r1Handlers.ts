import { ipcMain } from 'electron'
import { R1Items } from '../r1/items.js'
import { R1PersonaStore } from '../r1/persona.js'
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

export function registerR1Handlers(db: R1Database, ipc: IpcMainLike = ipcMain): void {
  const items = new R1Items(db)
  const persona = new R1PersonaStore(db)
  ipc.handle('r1.persona.get', () => ({ ok: true, data: persona.get() }))
  ipc.handle('r1.persona.update', action<Parameters<R1PersonaStore['update']>[0]>((payload) => persona.update(payload)))
  ipc.handle('r1.items.list', () => ({ ok: true, data: items.list() }))
  ipc.handle('r1.items.create', action<Parameters<R1Items['create']>[0]>((payload) => items.create(payload)))
  ipc.handle('r1.items.complete', action<Parameters<R1Items['complete']>[0]>((payload) => items.complete(payload)))
  ipc.handle('r1.items.deletionPreview', action<{ itemId: string }>((payload) => items.deletionPreview(payload.itemId)))
  ipc.handle('r1.items.delete', action<Parameters<R1Items['delete']>[0]>((payload) => items.delete(payload)))
  ipc.handle('r1.reminders.list', () => ({ ok: true, data: items.listReminders() }))
  ipc.handle('r1.reminders.create', action<Parameters<R1Items['createReminder']>[0]>((payload) => items.createReminder(payload)))
  ipc.handle('r1.reminders.reschedule', action<Parameters<R1Items['reschedule']>[0]>((payload) => items.reschedule(payload)))
  ipc.handle('r1.reminders.cancel', action<Parameters<R1Items['cancelReminder']>[0]>((payload) => items.cancelReminder(payload)))
}
