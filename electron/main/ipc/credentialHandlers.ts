import { ipcMain } from 'electron'
import { CredentialVault, type CredentialPatch } from '../r1/credentials.js'

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
}

export function registerCredentialHandlers(vault: CredentialVault, ipc: IpcMainLike = ipcMain): void {
  ipc.handle('r1.credentials.status', () => ({ ok: true, data: vault.status() }))
  ipc.handle('r1.credentials.save', (_event, payload) => {
    try {
      return { ok: true, data: vault.save(payload as CredentialPatch) }
    } catch (error) {
      const allowed = ['SYSTEM_SECRET_STORAGE_UNAVAILABLE', 'INVALID_CREDENTIAL_PATCH',
        'CREDENTIAL_FIELD_NOT_ALLOWED', 'INVALID_CREDENTIAL_VALUE', 'INVALID_REALTIME_VOICE']
      const message = error instanceof Error && allowed.includes(error.message) ? error.message : 'CREDENTIAL_SAVE_FAILED'
      return { ok: false, error: { code: message, message } }
    }
  })
}
