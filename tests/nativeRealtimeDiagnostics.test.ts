import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { expect, it, vi } from 'vitest'
import { readNativeUpgradeFailure, safeNativeFailureDetails } from '../electron/main/providers/nativeRealtimeDiagnostics'

function fixture() {
  const response = Object.assign(new EventEmitter(), { statusCode: 403,
    headers: { 'x-tt-logid': '20261016TESTLOGID' }, resume: vi.fn() })
  return { response, pending: readNativeUpgradeFailure(response as unknown as IncomingMessage) }
}
it('keeps only status, numeric provider code, safe correlation ID and an explicit resource failure category', async () => {
  const { response, pending } = fixture()
  response.emit('data', JSON.stringify({ code: 45000001, message: 'requested resource not granted; key=private-secret',
    authorization: 'private-secret' })); response.emit('end')
  const result = await pending
  expect(result).toEqual({ phase: 'http_upgrade', httpStatus: 403, providerCode: '45000001', logId: '20261016TESTLOGID', reason: 'resource_not_granted' })
  expect(JSON.stringify(result)).not.toContain('private-secret')
  expect(response.listenerCount('data')).toBe(0)
})
it.each(['<html>private-secret</html>', JSON.stringify({ message: 'private-secret', code: 'private-secret' }), 'x'.repeat(17000)])('does not include unknown, non-JSON or oversized bodies', async body => {
  const { response, pending } = fixture()
  response.emit('data', body); response.emit('end')
  const result = await pending
  expect(result.httpStatus).toBe(403)
  expect(result).not.toHaveProperty('providerCode')
  expect(JSON.stringify(result)).not.toContain('private-secret')
})
it('finishes on stream errors without exposing the exception', async () => {
  const { response, pending } = fixture()
  response.emit('error', new Error('private-secret'))
  expect(await pending).toEqual({ phase: 'http_upgrade', httpStatus: 403, logId: '20261016TESTLOGID' })
})
it('bounds a response that never ends and filters arbitrary extra detail fields', async () => {
  vi.useFakeTimers()
  try {
    const { pending } = fixture()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toMatchObject({ httpStatus: 403 })
    expect(safeNativeFailureDetails({ phase: 'http_upgrade', httpStatus: -1, providerCode: 'secret', logId: 'key=secret',
      reason: 'arbitrary message', credentials: 'private-secret' })).toEqual({ phase: 'http_upgrade' })
  } finally { vi.useRealTimers() }
})
