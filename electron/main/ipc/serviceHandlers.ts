import { ipcMain } from 'electron'
import type { R1ServiceDiagnostics } from '../r1/serviceDiagnostics.js'

type Owner = { id: number; once(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'destroyed', listener: () => void): unknown }
type IpcLike = { handle(channel: string, listener: (event: { sender: Owner }, payload?: unknown) => unknown): void }
export function registerServiceHandlers(service: R1ServiceDiagnostics, ipc: IpcLike = ipcMain): void {
  ipc.handle('r1.services.check', async (event, payload) => {
    const cancelled = () => service.cancel(event.sender.id)
    event.sender.once('destroyed', cancelled)
    try { return { ok: true, data: await service.check(event.sender.id, payload as Parameters<typeof service.check>[1]) } }
    catch (error) {
      const code = error instanceof Error && ['SERVICE_CHECK_INPUT_INVALID', 'SERVICE_CHECK_BUSY'].includes(error.message)
        ? error.message : 'SERVICE_CHECK_FAILED'
      return { ok: false, error: { code, message: code } }
    } finally { event.sender.removeListener('destroyed', cancelled) }
  })
  ipc.handle('r1.services.cancel', (event, payload) => {
    if (typeof payload !== 'string' || payload.length > 100) return { ok: false, error: {
      code: 'SERVICE_CHECK_INPUT_INVALID', message: 'SERVICE_CHECK_INPUT_INVALID' } }
    service.cancel(event.sender.id, payload)
    return { ok: true, data: null }
  })
}
