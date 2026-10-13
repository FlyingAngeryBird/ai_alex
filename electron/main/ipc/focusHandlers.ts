import { ipcMain } from 'electron'
import type { R1Focus } from '../r1/focus.js'

type Ipc = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void }
export function registerFocusHandlers(focus: R1Focus, ipc: Ipc = ipcMain): void {
  const action = <T>(run: (payload: T) => unknown) => (_event: unknown, payload?: unknown) => {
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_FOCUS_PAYLOAD')
      return { ok: true, data: run(payload as T) }
    } catch (error) {
      const code = error instanceof Error ? error.message : 'FOCUS_FAILED'
      return { ok: false, error: { code, message: code } }
    }
  }
  ipc.handle('r1.focus.getState', () => ({ ok: true, data: focus.getState() }))
  ipc.handle('r1.focus.start', action<Parameters<R1Focus['start']>[0]>(input => focus.start(input)))
  ipc.handle('r1.focus.pause', action<Parameters<R1Focus['pause']>[0]>(input => focus.pause(input)))
  ipc.handle('r1.focus.resume', action<Parameters<R1Focus['resume']>[0]>(input => focus.resume(input)))
  ipc.handle('r1.focus.stop', action<Parameters<R1Focus['stop']>[0]>(input => focus.stop(input)))
}
