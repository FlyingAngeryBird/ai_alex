import { afterEach, expect, it, vi } from 'vitest'
import { useNativeConversation } from '../src/composables/useNativeConversation'
afterEach(() => vi.unstubAllGlobals())
it('opens the microphone only for the active connection and clears queued audio and capture on stop', async () => {
  let listener: (event: Record<string, unknown>) => void = () => undefined
  const trackStop = vi.fn(), audioStop = vi.fn(), closed = vi.fn(), unsubscribe = vi.fn()
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() })
  class Context {
    sampleRate = 16000; currentTime = 0
    audioWorklet = { addModule: async () => undefined }
    destination = {}; resume = async () => undefined; close = closed
    createMediaStreamSource = node
    createScriptProcessor = () => ({ ...node(), onaudioprocess: null })
    createGain = () => ({ ...node(), gain: { value: 1 } })
    createBuffer = (_channels: number, size: number) => ({ duration: size / 24000, getChannelData: () => new Float32Array(size) })
    createBufferSource = () => ({ ...node(), buffer: null, onended: null, start: vi.fn(), stop: audioStop })
  }
  class Worklet {
    connect = vi.fn(); disconnect = vi.fn()
    port = { close: vi.fn(), onmessage: null as null | ((event: { data: Record<string, unknown> }) => void),
      postMessage: (data: Record<string, unknown>) => {
        if (data.type === 'audio') this.port.onmessage?.({ data: { type: 'playback', status: 'started' } })
        if (data.type === 'clear') { audioStop(); this.port.onmessage?.({ data: { type: 'cleared', requestId: data.requestId } }) }
      } }
  }
  vi.stubGlobal('AudioWorkletNode', Worklet)
  vi.stubGlobal('document', { baseURI: 'file:///test/index.html' })
  const invoke = vi.fn(async (channel: string) => ({ ok: true, data: channel === 'app.requestMicrophoneAccess' ? { granted: true } : null }))
  vi.stubGlobal('AudioContext', Context)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: trackStop, addEventListener: vi.fn() }] }) } })
  vi.stubGlobal('window', { lingli: { invoke, on: (_channel: string, cb: typeof listener) => { listener = cb; return unsubscribe } } })
  const onError = vi.fn(), onText = vi.fn(), onSpeaking = vi.fn()
  const voice = useNativeConversation({ onError, onText, onSpeaking })
  expect(await voice.start()).toBe(true)
  const id = (invoke.mock.calls.find(([channel]) => channel === 'voice.nativeStart') as unknown as [string, { connectionId: string }])[1].connectionId
  listener({ connectionId: 'other', type: 'response.output_audio.delta', response_id: 'r', delta: 'AAA=' })
  expect(voice.speaking.value).toBe(false)
  listener({ connectionId: id, type: 'response.output_audio.delta', response_id: 'r', delta: 'AAA=' })
  expect(voice.speaking.value).toBe(true)
  await voice.interrupt()
  expect(audioStop).toHaveBeenCalledTimes(1)
  listener({ connectionId: id, type: 'response.output_audio.delta', response_id: 'r', delta: 'AAA=' })
  expect(voice.speaking.value).toBe(false)
  await voice.stop()
  expect(trackStop).toHaveBeenCalledOnce(); expect(closed).toHaveBeenCalledOnce(); expect(unsubscribe).toHaveBeenCalledOnce()
  expect(onError).not.toHaveBeenCalled(); expect(voice.active.value).toBe(false)
})
