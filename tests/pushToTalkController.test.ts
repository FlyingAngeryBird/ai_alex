import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPushToTalkController } from '../src/services/pushToTalkController'

function setup(start = vi.fn(async () => true)) {
  const finish = vi.fn(async () => undefined)
  const cancel = vi.fn(async () => undefined)
  const onHeldChange = vi.fn()
  const controller = createPushToTalkController({ start, finish, cancel, canStart: () => true,
    onHeldChange, onError: error => { throw error } })
  return { controller, start, finish, cancel, onHeldChange }
}
afterEach(() => vi.useRealTimers())

describe('push-to-talk ownership and lifecycle', () => {
  it('allows only the held input to release the recording and submits once', async () => {
    const { controller, start, finish, cancel } = setup()
    await controller.press('button')
    await controller.press('keyboard')
    await controller.release('keyboard')
    expect(controller.isBusy()).toBe(true)
    expect(finish).not.toHaveBeenCalled()
    await controller.release('button')
    await controller.release('button')
    expect(start).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()
    expect(controller.isBusy()).toBe(false)
  })

  it('finishes a quick press only after microphone startup resolves', async () => {
    let resolveStart: (started: boolean) => void = () => undefined
    const { controller, finish } = setup(vi.fn(() => new Promise<boolean>(resolve => { resolveStart = resolve })))
    const pending = controller.press('keyboard')
    await controller.release('keyboard')
    expect(finish).not.toHaveBeenCalled()
    resolveStart(true)
    await pending
    expect(finish).toHaveBeenCalledTimes(1)
    expect(controller.isBusy()).toBe(false)
  })

  it('cancels a startup that resolves after focus loss and never submits it', async () => {
    let resolveStart: (started: boolean) => void = () => undefined
    const { controller, finish, cancel, start } = setup(vi.fn(() => new Promise<boolean>(resolve => { resolveStart = resolve })))
    const pending = controller.press('button')
    await controller.cancel()
    await controller.press('keyboard')
    expect(start).toHaveBeenCalledTimes(1)
    resolveStart(true)
    await pending
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(finish).not.toHaveBeenCalled()
    expect(controller.isBusy()).toBe(false)
  })

  it('enforces the 60-second limit and disposal cancels rather than completes', async () => {
    vi.useFakeTimers()
    const { controller, finish, cancel } = setup()
    await controller.press('keyboard')
    await vi.advanceTimersByTimeAsync(59_999)
    expect(finish).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(finish).toHaveBeenCalledTimes(1)
    await controller.press('button')
    await controller.dispose()
    await controller.press('keyboard')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(controller.isBusy()).toBe(false)
  })
  it('recovers after failed startup without attempting to submit a recording', async () => {
    const { controller, finish, cancel, onHeldChange } = setup(vi.fn(async () => false))
    await controller.press('button')
    await controller.release('button')
    expect(controller.isBusy()).toBe(false)
    expect(controller.owner()).toBeNull()
    expect(onHeldChange).toHaveBeenLastCalledWith(false)
    expect(finish).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
  })
  it('lets a mode switch wait until a cancelled microphone startup has actually been cleaned up', async () => {
    let resolveStart: (started: boolean) => void = () => undefined
    const { controller, cancel } = setup(vi.fn(() => new Promise<boolean>(resolve => { resolveStart = resolve })))
    const pending = controller.press('button')
    await controller.cancel()
    let idle = false
    const idleWait = controller.whenIdle().then(() => { idle = true })
    await Promise.resolve()
    expect(idle).toBe(false)
    resolveStart(true)
    await pending
    await idleWait
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(idle).toBe(true)
  })
})
