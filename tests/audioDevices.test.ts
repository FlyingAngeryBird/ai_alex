import { expect, it, vi } from 'vitest'
import { createAudioDevices } from '../src/services/audioDevices'
function fixture(outputTimeoutMs?: number) {
  let input: string | null = 'mic-a', output: string | null = 'headphone-a'
  const listeners = new Map<string, () => void>(), track = { stop: vi.fn() }, failure = vi.fn()
  const media = { enumerateDevices: vi.fn(async () => [{ kind: 'audioinput', deviceId: 'mic-a', label: '合成麦克风' }, { kind: 'audiooutput', deviceId: 'headphone-a', label: '合成耳机' }] as MediaDeviceInfo[]),
    getUserMedia: vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream),
    addEventListener: vi.fn((event: string, listener: () => void) => { listeners.set(event, listener) }), removeEventListener: vi.fn() }
  const devices = createAudioDevices({ mediaDevices: () => media as unknown as MediaDevices, inputId: () => input, outputId: () => output, onOutputFailure: failure, outputTimeoutMs })
  return { devices, media, track, failure, listeners, selectOutput(value: string | null) { output = value }, selectInput(value: string | null) { input = value } }
}
it('enumerates without opening a microphone and releases an explicitly authorized permission probe', async () => {
  const s = fixture()
  try {
    s.devices.start(); await s.devices.refresh()
    expect(s.media.getUserMedia).not.toHaveBeenCalled()
    expect(s.devices.inputConstraints({ echoCancellation: true })).toEqual({ echoCancellation: true, deviceId: { exact: 'mic-a' } })
    await s.devices.requestPermission()
    expect(s.track.stop).toHaveBeenCalledTimes(1)
    s.selectInput(null); expect(s.devices.inputConstraints()).toEqual({})
  } finally { s.devices.dispose() }
})
it('serializes output changes and applies the latest selection after a slow older route', async () => {
  const s = fixture(); let release!: () => void
  const target = { setSinkId: vi.fn(async () => {}), pause: vi.fn() }
  target.setSinkId.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
  try {
    const binding = s.devices.bindOutput(target as unknown as HTMLAudioElement)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    s.selectOutput('headphone-b'); const routed = s.devices.routeOutputs()
    release(); const unbind = await binding; expect(await routed).toBe(true)
    expect(target.setSinkId.mock.calls).toEqual([['headphone-a'], ['headphone-b']])
    unbind(); s.selectOutput(null); await s.devices.routeOutputs(); expect(target.setSinkId).toHaveBeenCalledTimes(2)
  } finally { s.devices.dispose() }
})
it('stops active output after a route failure or selected-device disappearance instead of silently switching devices', async () => {
  const s = fixture(), target = { setSinkId: vi.fn(async () => {}), pause: vi.fn() }
  try {
    s.devices.start(); await s.devices.refresh(); await s.devices.bindOutput(target as unknown as HTMLAudioElement)
    s.selectOutput('headphone-b'); target.setSinkId.mockRejectedValueOnce(new Error('unavailable'))
    expect(await s.devices.routeOutputs()).toBe(false); expect(target.pause).toHaveBeenCalledTimes(1); expect(s.failure).toHaveBeenCalledTimes(1)
    s.selectOutput('headphone-a'); s.media.enumerateDevices.mockResolvedValueOnce([])
    s.listeners.get('devicechange')!()
    await vi.waitFor(() => expect(s.failure).toHaveBeenCalledTimes(2))
    expect(s.devices.error.value).toContain('当前不可用')
  } finally { s.devices.dispose() }
})
it('times out a stuck output device and permits a fresh target without reviving the quarantined one', async () => {
  const s = fixture(10), old = { setSinkId: vi.fn(() => new Promise<void>(() => {})), pause: vi.fn() }, fresh = { setSinkId: vi.fn(async () => {}) }
  try {
    await expect(s.devices.bindOutput(old as unknown as HTMLAudioElement)).rejects.toThrow('AUDIO_OUTPUT_TIMEOUT')
    expect(s.failure).toHaveBeenCalledTimes(1); expect(old.pause).toHaveBeenCalledTimes(1)
    await s.devices.bindOutput(fresh as unknown as HTMLAudioElement)
    expect(await s.devices.routeOutputs()).toBe(true); expect(s.failure).toHaveBeenCalledTimes(1)
    await expect(s.devices.bindOutput(old as unknown as HTMLAudioElement)).rejects.toThrow('AUDIO_OUTPUT_TIMEOUT')
  } finally { s.devices.dispose() }
})
