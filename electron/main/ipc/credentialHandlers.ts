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
      const message = error instanceof Error ? error.message : '保存服务配置失败'
      return { ok: false, error: { code: message, message } }
    }
  })
}
