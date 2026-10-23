import { ipcMain } from 'electron'
import type { R1ItemActions } from '../r1/itemActions.js'

type Ipc = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void }
type ResolveInput = { ticket: string; decision: 'delete' | 'export' | 'cancel'; reminderDisposition?: 'keep' | 'cancel' }

/**
 * The renderer that owns the pending ticket confirms with its real webContents
 * id; a ticket never names its owner and cannot be replayed from another window.
 */
export function registerItemActionHandlers(actions: R1ItemActions, ipc: Ipc = ipcMain): void {
  ipc.handle('r1.items.resolveAction', async (event: unknown, payload?: unknown) => {
    try {
      const ownerId = (event as { sender?: { id?: number } })?.sender?.id
      if (!ownerId) throw new Error('ITEM_ACTION_OWNER_MISMATCH')
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_ITEM_ACTION')
      const input = payload as ResolveInput
      const data = await actions.resolve(ownerId, input)
      return { ok: true as const, data }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'ITEM_ACTION_FAILED'
      return { ok: false as const, error: { code, message: code } }
    }
  })
}
