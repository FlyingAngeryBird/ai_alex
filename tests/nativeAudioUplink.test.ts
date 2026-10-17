import { afterEach, expect, it, vi } from 'vitest'
import { createNativeAudioUplink } from '../src/services/nativeAudioUplink'
afterEach(() => vi.useRealTimers())
const frame = () => new Uint8Array(640)
it('paces queued 20ms frames instead of flushing them as an IPC burst', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const times: number[] = [], onError = vi.fn()
  const uplink = createNativeAudioUplink({ now: () => Date.now(), send: async () => { times.push(Date.now()) }, onError })
  for (let i = 0; i < 6; i++) uplink.enqueue(frame())
  await vi.advanceTimersByTimeAsync(100)
  expect(times).toEqual([0, 20, 40, 60, 80, 100])
  expect(onError).not.toHaveBeenCalled(); uplink.stop()
})
it('tolerates five buffered IPC frames during a short stall, and resumes without catch-up bursts', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  let release!: () => void
  const times: number[] = [], onError = vi.fn()
  const send = vi.fn(() => { times.push(Date.now()); return times.length === 1 ? new Promise<void>(resolve => { release = resolve }) : Promise.resolve() })
  const uplink = createNativeAudioUplink({ now: () => Date.now(), send, onError })
  for (let i = 0; i < 6; i++) uplink.enqueue(frame())
  await vi.advanceTimersByTimeAsync(100)
  expect(send).toHaveBeenCalledTimes(1); expect(onError).not.toHaveBeenCalled()
  release(); await vi.advanceTimersByTimeAsync(100)
  expect(times).toEqual([0, 100, 120, 140, 160, 180]); uplink.stop()
})
it('bounds a sustained stall and reports it once without later sending queued audio', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const send = vi.fn(() => new Promise<void>(() => undefined)), onError = vi.fn()
  const uplink = createNativeAudioUplink({ now: () => Date.now(), send, onError })
  uplink.enqueue(frame()); await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(1000)
  uplink.enqueue(frame())
  expect(onError).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce()
})
it('drops queued audio on stop and prevents a late old IPC completion affecting a replacement uploader', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  let release!: () => void
  const oldSend = vi.fn(() => new Promise<void>(resolve => { release = resolve })), onError = vi.fn()
  const old = createNativeAudioUplink({ now: () => Date.now(), send: oldSend, onError })
  old.enqueue(frame()); old.enqueue(frame()); await vi.advanceTimersByTimeAsync(0); old.stop()
  const newSend = vi.fn(async () => undefined), next = createNativeAudioUplink({ now: () => Date.now(), send: newSend, onError })
  next.enqueue(frame()); release(); await vi.advanceTimersByTimeAsync(100)
  expect(oldSend).toHaveBeenCalledOnce(); expect(newSend).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled(); next.stop()
})
it('rejects excessive buffering and invalid PCM without forwarding it', async () => {
  const send = vi.fn(async () => undefined), onError = vi.fn()
  const uplink = createNativeAudioUplink({ send, onError })
  uplink.enqueue(new Uint8Array(17000)); uplink.enqueue(frame())
  await Promise.resolve()
  expect(onError).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled()
})

it('does not accumulate one millisecond of timer rounding per frame in a healthy continuous stream', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const send = vi.fn(async () => undefined), onError = vi.fn()
  const uplink = createNativeAudioUplink({ now: () => Date.now(), send, onError })
  // Deliver each scheduled timer 1ms late, as happens with real timer granularity.
  const realTimeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay: number) => realTimeout(fn, delay + 1)) as typeof setTimeout)
  for (let i = 0; i < 1000; i++) { uplink.enqueue(frame()); await vi.advanceTimersByTimeAsync(20) }
  expect(onError).not.toHaveBeenCalled()
  expect(send.mock.calls.length).toBeGreaterThanOrEqual(999)
  uplink.stop(); vi.restoreAllMocks()
})
