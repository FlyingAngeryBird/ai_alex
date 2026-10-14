import { ipcMain } from 'electron'
import type { R1AutomaticMemory } from '../r1/automaticMemory.js'
export function registerAutomaticMemoryHandlers(service: R1AutomaticMemory, onAuthorizationChanged: () => void, ipc: {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
} = ipcMain): void {
  ipc.handle('r1.memory.policy', () => ({ ok: true, data: { ...service.getPolicy(), ...service.getState() } }))
  ipc.handle('r1.memory.setPolicy', (_event, payload) => {
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !['enabled', 'expectedVersion'].includes(key))) throw new Error('INVALID_MEMORY_POLICY')
      const before = service.getPolicy(), next = service.updatePolicy(payload as { enabled: boolean; expectedVersion: number })
      if (before.version !== next.version) onAuthorizationChanged()
      return { ok: true, data: { ...next, ...service.getState() } }
    } catch (error) { const code = error instanceof Error ? error.message : 'MEMORY_POLICY_FAILED'; return { ok: false, error: { code, message: code } } }
  })
}
