import { ipcMain } from 'electron'
import type { R1MemoryConfirmations } from '../r1/memoryConfirmations.js'
export function registerMemoryConfirmationHandlers(confirmations: R1MemoryConfirmations, ipc: {
  handle(channel: string, handler: (event: unknown, payload: unknown) => unknown): void
} = ipcMain): void {
  for (const operation of ['confirm', 'cancel'] as const) ipc.handle(`r1.memory.${operation}Save`, (event, payload) => {
    try {
      const ownerId = (event as { sender?: { id?: number } })?.sender?.id
      if (!ownerId || !payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).length !== 1 || typeof (payload as { confirmationId?: unknown }).confirmationId !== 'string') throw new Error('INVALID_MEMORY_CONFIRMATION')
      const id = (payload as { confirmationId: string }).confirmationId
      const result = operation === 'confirm' ? confirmations.commit(ownerId, id) : confirmations.cancel(ownerId, id)
      return { ok: true, data: result ?? null }
    } catch (error) { const code = error instanceof Error ? error.message : 'MEMORY_CONFIRMATION_FAILED'; return { ok: false, error: { code, message: code } } }
  })
}
