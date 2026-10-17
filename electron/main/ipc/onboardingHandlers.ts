import { ipcMain } from 'electron'
import type { R1Onboarding } from '../r1/onboarding.js'

export function registerOnboardingHandlers(store: R1Onboarding, ipc: Pick<typeof ipcMain, 'handle'> = ipcMain): void {
  const run = (action: () => unknown) => {
    try { return { ok: true, data: action() } }
    catch { return { ok: false, error: { code: 'ONBOARDING_UNAVAILABLE', message: '引导状态暂时无法保存，请重试。' } } }
  }
  ipc.handle('r1.onboarding.get', () => run(() => store.get()))
  ipc.handle('r1.onboarding.complete', (_event, input) => run(() => store.complete(input as { skipped: boolean })))
}
