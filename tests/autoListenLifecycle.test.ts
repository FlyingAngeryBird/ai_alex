import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAutoListen } from '../src/composables/useAutoListen'

// These tests drive explicit start/stop without mounting a Vue component.
vi.mock('vue', async importOriginal => ({ ...(await importOriginal<typeof import('vue')>()),
  onBeforeUnmount: () => undefined }))
afterEach(() => vi.unstubAllGlobals())

describe('automatic microphone lifecycle', () => {
  it('does not resurrect the microphone when permission resolves after disabling automatic conversation', async () => {
    const track = { stop: vi.fn() }
    const stream = { getTracks: () => [track] } as unknown as MediaStream
    let resolvePermission: (value: MediaStream) => void = () => undefined
    const AudioContext = vi.fn()
    vi.stubGlobal('window', { AudioContext })
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(() =>
      new Promise<MediaStream>(resolve => { resolvePermission = resolve })) } })
    const automatic = useAutoListen()
    const pending = automatic.start()
    automatic.stop()
    resolvePermission(stream)
    expect(await pending).toBe(false)
    expect(automatic.enabled.value).toBe(false)
    expect(automatic.getMediaStream()).toBeNull()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(AudioContext).not.toHaveBeenCalled()
  })
})
