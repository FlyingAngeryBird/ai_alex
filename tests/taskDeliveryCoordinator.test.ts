import { afterEach, expect, it, vi } from 'vitest'
import { createTaskDeliveryCoordinator } from '../src/services/taskDeliveryCoordinator'
const notice = { key: 'result-v1', taskId: 'task', goalVersion: 1, resultId: 'result', completionStatus: 'completed' }
const audio = { text: '已整理完成。', audio: new ArrayBuffer(4), mimeType: 'audio/wav' as const, responseId: 'fixture-response' }
function fixture() {
  vi.useFakeTimers()
  const prepare = vi.fn(async () => ({ ok: true, data: audio })), cancel = vi.fn(), play = vi.fn(async () => undefined), stop = vi.fn()
  return { prepare, cancel, play, stop, coordinator: createTaskDeliveryCoordinator({ prepare, cancel, play, stop, requestId: () => 'request' }) }
}
afterEach(() => vi.useRealTimers())
it('does not request a prompt while blocked and waits for an idle gap', async () => {
  const f = fixture(); f.coordinator.update(notice, false); await vi.advanceTimersByTimeAsync(1000); expect(f.prepare).not.toHaveBeenCalled()
  f.coordinator.update(notice, true); await vi.advanceTimersByTimeAsync(599); expect(f.prepare).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1); expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.play).toHaveBeenCalledWith(audio, expect.any(Function)); f.coordinator.dispose()
})
it('cancels a late prepared response on user activity and never replays it', async () => {
  const f = fixture(); let finish!: (value: { ok: boolean; data: typeof audio }) => void
  f.prepare.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  f.coordinator.update(notice, true); await vi.advanceTimersByTimeAsync(600)
  f.coordinator.update(notice, false); expect(f.cancel).toHaveBeenCalledWith('request'); expect(f.stop).toHaveBeenCalledTimes(1)
  finish({ ok: true, data: audio }); await Promise.resolve(); expect(f.play).not.toHaveBeenCalled()
  f.coordinator.update(notice, true); await vi.advanceTimersByTimeAsync(1000); expect(f.prepare).toHaveBeenCalledTimes(1); f.coordinator.dispose()
})
it('replaces an unstarted timer when a newer result arrives and drops scope-cleared results', async () => {
  const f = fixture(); f.coordinator.update(notice, true); await vi.advanceTimersByTimeAsync(300)
  f.coordinator.update({ ...notice, key: 'result-v2', resultId: 'next', goalVersion: 2 }, true)
  await vi.advanceTimersByTimeAsync(600); expect(f.prepare).toHaveBeenCalledWith(expect.objectContaining({ resultId: 'next', goalVersion: 2 }))
  f.coordinator.update(null, true); expect(f.stop).toHaveBeenCalledTimes(1); f.coordinator.dispose()
})
it('does not retry failures or create audio for failed tasks', async () => {
  const f = fixture(); f.prepare.mockRejectedValueOnce(new Error('offline'))
  f.coordinator.update({ ...notice, completionStatus: 'failed' }, true); await vi.advanceTimersByTimeAsync(1000); expect(f.prepare).not.toHaveBeenCalled()
  f.coordinator.update(notice, true); await vi.advanceTimersByTimeAsync(1000); f.coordinator.update(notice, true)
  await vi.advanceTimersByTimeAsync(1000); expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.play).not.toHaveBeenCalled(); f.coordinator.dispose()
})
it('binds device receipts to the original request and reports stop progress before cancelling the server ticket', async () => {
  vi.useFakeTimers()
  const sequence: string[] = [], report = vi.fn(() => { sequence.push('receipt') })
  let callback!: (value: { status: 'interrupted'; playedUntilMs: number }) => void
  const coordinator = createTaskDeliveryCoordinator({
    prepare: async () => ({ ok: true, data: audio }), requestId: () => 'bound-request', report,
    play: async (_audio, onPlayback) => { callback = onPlayback },
    stop: () => callback({ status: 'interrupted', playedUntilMs: 420 }),
    cancel: () => { sequence.push('cancel') }
  })
  coordinator.update(notice, true); await vi.advanceTimersByTimeAsync(600)
  coordinator.cancel()
  expect(report).toHaveBeenCalledWith({ requestId: 'bound-request', status: 'interrupted', playedUntilMs: 420 })
  expect(sequence).toEqual(['receipt', 'cancel']); coordinator.dispose()
})
it('prioritizes a reminder over a task through the same speech owner, without replaying the interrupted task', async () => {
  const f = fixture()
  f.coordinator.update(notice, true); await vi.advanceTimersByTimeAsync(600)
  f.coordinator.update({ key: 'reminder-key', deliveryId: 'delivery' }, true)
  expect(f.stop).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(600)
  expect(f.prepare).toHaveBeenLastCalledWith({ deliveryId: 'delivery', requestId: 'request' })
  f.coordinator.update(notice, true); await vi.advanceTimersByTimeAsync(1000)
  expect(f.prepare).toHaveBeenCalledTimes(2); f.coordinator.dispose()
})
