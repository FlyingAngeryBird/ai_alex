import { ipcMain } from 'electron'
import { CredentialVault, type CredentialPatch } from '../r1/credentials.js'

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
}

export function registerCredentialHandlers(vault: CredentialVault, ipc: IpcMainLike = ipcMain): void {
  const failed = (error: unknown) => {
    const allowed = ['SYSTEM_SECRET_STORAGE_UNAVAILABLE', 'CREDENTIAL_LOAD_FAILED', 'INVALID_CREDENTIAL_PATCH',
      'CREDENTIAL_FIELD_NOT_ALLOWED', 'INVALID_CREDENTIAL_VALUE', 'INVALID_REALTIME_VOICE']
    const code = error instanceof Error && allowed.includes(error.message) ? error.message : 'CREDENTIAL_SAVE_FAILED'
    return { ok: false, error: { code, message: code } }
  }
  ipc.handle('r1.credentials.status', () => {
    try { return { ok: true, data: vault.needsReload ? vault.load() : vault.status() } }
    catch (error) { return failed(error) }
  })
  ipc.handle('r1.credentials.save', (_event, payload) => {
    try {
      return { ok: true, data: vault.save(payload as CredentialPatch) }
    } catch (error) {
      return failed(error)
    }
  })
}
