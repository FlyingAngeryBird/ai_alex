import { describe, expect, it } from 'vitest'
import { invokeWithTimeout } from '../src/utils/invokeWithTimeout'

describe('invokeWithTimeout', () => {
  it('returns the invoke result when it settles before the timeout', async () => {
    await expect(
      invokeWithTimeout(Promise.resolve({ ok: true, data: { ready: true } }), 20, '超时')
    ).resolves.toEqual({
      ok: true,
      data: {
        ready: true
      }
    })
  })

  it('returns a clear timeout error instead of hanging', async () => {
    await expect(
      invokeWithTimeout(new Promise(() => undefined), 1, '服务响应超时')
    ).resolves.toEqual({
      ok: false,
      error: {
        code: 'IPC_TIMEOUT',
        message: '服务响应超时'
      }
    })
  })
})
