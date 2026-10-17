import type { AppResult } from '@/types/electron-api'

export function invokeWithTimeout<T>(
  promise: Promise<AppResult<T>>,
  timeoutMs: number,
  message: string
): Promise<AppResult<T>> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined

  const timeout = new Promise<AppResult<T>>((resolve) => {
    timer = globalThis.setTimeout(() => {
      resolve({
        ok: false,
        error: {
          code: 'IPC_TIMEOUT',
          message
        }
      })
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer)
    }
  })
}
