import { afterEach, expect, it, vi } from 'vitest'
import { useNativeConversation } from '../src/composables/useNativeConversation'
afterEach(() => vi.unstubAllGlobals())

function recoveryFixture(options: Pick<Parameters<typeof useNativeConversation>[0], 'inputConstraints' | 'configureOutput' | 'checkReady' | 'onConfigurationRequired'> = {}) {
  const subscriptions: Array<(event: Record<string, unknown>) => void> = [], trackStops: ReturnType<typeof vi.fn>[] = [], order: string[] = []
  class Context {
    destination = {}; audioWorklet = { addModule: async () => undefined }
    resume = async () => undefined; close = async () => undefined
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} })
  }
  const worklets: Worklet[] = []
  class Worklet {
    onprocessorerror: (() => void) | null = null
    holdClears = false
    pendingClears: unknown[] = []
    acknowledgeClear() { this.port.onmessage?.({ data: { type: 'cleared', requestId: this.pendingClears.shift() } }) }
    connect() {} disconnect() {}
    constructor() { worklets.push(this) }
    port = { close() {}, onmessage: null as null | ((event: { data: Record<string, unknown> }) => void),
      postMessage: (data: Record<string, unknown>) => {
        order.push(String(data.type) + (data.enabled === undefined ? '' : `:${data.enabled}`))
        if (data.type === 'clear') {
          if (this.holdClears) this.pendingClears.push(data.requestId)
          else this.port.onmessage?.({ data: { type: 'cleared', requestId: data.requestId } })
        }
      } }
  }
  const startReplies: Array<{ ok: false; error: { code: string } }> = []
  const invoke = vi.fn(async (channel: string, _input?: unknown) => {
    order.push(channel)
    if (channel === 'voice.nativeStart' && startReplies.length) return startReplies.shift()!
    return { ok: true as const, data: channel === 'app.requestMicrophoneAccess' ? { granted: true } : null }
  })
  const media = vi.fn(async () => {
    const stop = vi.fn(); trackStops.push(stop)
    return { getTracks: () => [{ stop, addEventListener() {} }] }
  })
  vi.stubGlobal('document', { baseURI: 'file:///test/index.html' }); vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioWorkletNode', Worklet)
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: media } })
  vi.stubGlobal('window', { lingli: { invoke, on: (_channel: string, listener: typeof subscriptions[number]) => { subscriptions.push(listener); return vi.fn() } } })
  const onError = vi.fn(), onConnectionState = vi.fn(), onText = vi.fn()
  const voice = useNativeConversation({ ...options, onError, onConnectionState, onText, onSpeaking() {} })
  const starts = () => invoke.mock.calls.filter(([name]) => name === 'voice.nativeStart')
  const emit = (index: number, event: Record<string, unknown>) => subscriptions[index]({ connectionId: (starts()[index][1] as { connectionId: string }).connectionId, ...event })
  return { voice, starts, invoke, emit, onError, onText, onConnectionState, worklets, trackStops, order, startReplies, media }
}

it('reports missing configuration before permission, capture or native service startup', async () => {
  const onConfigurationRequired = vi.fn(), checkReady = vi.fn(async () => { throw new Error('REALTIME_NOT_CONFIGURED') })
  const s = recoveryFixture({ checkReady, onConfigurationRequired })
  expect(await s.voice.start()).toBe(false)
  expect(onConfigurationRequired).toHaveBeenCalledOnce()
  expect(s.onError).toHaveBeenCalledWith(expect.stringContaining('原生实时对话 3.0 API Key'))
  expect(s.invoke.mock.calls.some(([name]) => name === 'app.requestMicrophoneAccess')).toBe(false)
  expect(s.media).not.toHaveBeenCalled(); expect(s.starts()).toHaveLength(0)
  expect(s.voice.starting.value).toBe(false)
})

it('ignores a late configuration result after the user stops, and allows a fresh attempt', async () => {
  let release!: () => void
  const checkReady = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve })).mockResolvedValue(undefined)
  const s = recoveryFixture({ checkReady })
  const first = s.voice.start()
  expect(await s.voice.start()).toBe(false)
  await s.voice.stop(); release()
  expect(await first).toBe(false)
  expect(s.media).not.toHaveBeenCalled(); expect(s.onError).not.toHaveBeenCalled()
  try { expect(await s.voice.start()).toBe(true); expect(checkReady).toHaveBeenCalledTimes(2) }
  finally { await s.voice.stop() }
})

it('binds native capture/output to selected devices and stops cleanly after the microphone is lost', async () => {
  const releaseOutput = vi.fn(), configureOutput = vi.fn(async () => releaseOutput), s = recoveryFixture({ inputConstraints: () => ({ deviceId: { exact: 'synthetic-mic' } }), configureOutput })
  let ended!: () => void
  const trackStop = vi.fn()
  s.media.mockResolvedValueOnce({ getTracks: () => [{ stop: trackStop, addEventListener: ((_event: string, listener: () => void) => { ended = listener }) as () => void }] })
  try {
    expect(await s.voice.start()).toBe(true)
    expect(s.media).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'synthetic-mic' } } })
    expect(configureOutput).toHaveBeenCalledTimes(1)
    ended(); await vi.waitFor(() => expect(trackStop).toHaveBeenCalledTimes(1))
    expect(s.voice.active.value).toBe(false); expect(s.onError).toHaveBeenCalledWith(expect.stringContaining('麦克风已断开'))
    expect(releaseOutput).toHaveBeenCalledTimes(1)
  } finally { await s.voice.stop() }
})

it('rebuilds after context invalidation, clears old audio first, and rejects old connection events', async () => {
  const s = recoveryFixture()
  try {
    expect(await s.voice.start()).toBe(true)
    s.order.length = 0
    s.emit(0, { type: 'closed', code: 'MEMORY_CONTEXT_REFRESH_REQUIRED' })
    expect(s.voice.active.value).toBe(false)
    expect(s.order.slice(0, 3)).toEqual(['capture:false', 'capture:false', 'clear'])
    await vi.waitFor(() => expect(s.starts()).toHaveLength(2))
    await vi.waitFor(() => expect(s.voice.active.value).toBe(true))
    expect(s.trackStops[0]).toHaveBeenCalledOnce()
    expect(s.order.indexOf('clear')).toBeLessThan(s.order.indexOf('voice.nativeStart'))
    expect(s.starts()[0][1]).not.toEqual(s.starts()[1][1])
    s.emit(0, { type: 'response.output_text.done', response_id: 'late', text: '旧结论' })
    expect(s.onText).not.toHaveBeenCalled()
    s.emit(1, { type: 'response.output_text.done', response_id: 'new', text: '新结论' })
    expect(s.onText).toHaveBeenCalledOnce()
    expect(s.onConnectionState.mock.calls.map(([state]) => state)).toEqual(['ready', 'rebuilding', 'ready'])
    expect(s.onError).not.toHaveBeenCalled()
  } finally { await s.voice.stop() }
})

it('cancels recovery when the user closes voice while replacement microphone access is pending', async () => {
  const s = recoveryFixture()
  let release: (stream: Awaited<ReturnType<typeof s.media>>) => void = () => undefined
  try {
    await s.voice.start()
    s.media.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    s.emit(0, { type: 'closed', code: 'MEMORY_CONTEXT_REFRESH_REQUIRED' })
    await vi.waitFor(() => expect(s.media).toHaveBeenCalledTimes(2))
    await s.voice.stop()
    const lateStop = vi.fn(); release({ getTracks: () => [{ stop: lateStop, addEventListener() {} }] })
    await vi.waitFor(() => expect(lateStop).toHaveBeenCalledOnce())
    expect(s.starts()).toHaveLength(1); expect(s.voice.active.value).toBe(false)
    expect(s.onError).not.toHaveBeenCalled()
  } finally { await s.voice.stop() }
})

it.each(['REALTIME_AUTH_FAILED', 'REALTIME_QUOTA_LIMIT', 'REALTIME_SERVER_REJECTED'])('does not reconnect after %s', async code => {
  const s = recoveryFixture()
  try {
    await s.voice.start(); s.emit(0, { type: 'closed', code })
    await vi.waitFor(() => expect(s.trackStops[0]).toHaveBeenCalledOnce())
    expect(s.starts()).toHaveLength(1); expect(s.onError).toHaveBeenCalledOnce()
  } finally { await s.voice.stop() }
})

it('limits repeated connection failures to two automatic attempts', async () => {
  const s = recoveryFixture()
  try {
    await s.voice.start()
    s.startReplies.push({ ok: false, error: { code: 'REALTIME_NETWORK_FAILED' } }, { ok: false, error: { code: 'REALTIME_NETWORK_FAILED' } })
    s.emit(0, { type: 'closed', code: 'REALTIME_NETWORK_FAILED' })
    await vi.waitFor(() => expect(s.onError).toHaveBeenCalledOnce(), { timeout: 2000 })
    expect(s.starts()).toHaveLength(3); expect(s.voice.active.value).toBe(false)
    expect(s.trackStops).toHaveLength(3); expect(s.trackStops.every(stop => stop.mock.calls.length === 1)).toBe(true)
  } finally { await s.voice.stop() }
})

it('recovers an initial network failure without reporting a false terminal error', async () => {
  const s = recoveryFixture()
  try {
    s.startReplies.push({ ok: false, error: { code: 'REALTIME_NETWORK_FAILED' } })
    expect(await s.voice.start()).toBe(true)
    expect(s.starts()).toHaveLength(2); expect(s.onError).not.toHaveBeenCalled()
  } finally { await s.voice.stop() }
})

it('keeps the retry budget across short-lived successful connections until real user input arrives', async () => {
  const s = recoveryFixture()
  try {
    await s.voice.start()
    for (let index = 0; index < 2; index++) {
      s.emit(index, { type: 'closed', code: 'REALTIME_CONNECTION_CLOSED' })
      await vi.waitFor(() => expect(s.starts()).toHaveLength(index + 2), { timeout: 1500 })
      await vi.waitFor(() => expect(s.voice.active.value).toBe(true))
    }
    s.emit(2, { type: 'closed', code: 'REALTIME_CONNECTION_CLOSED' })
    await vi.waitFor(() => expect(s.onError).toHaveBeenCalledOnce())
    expect(s.starts()).toHaveLength(3)
  } finally { await s.voice.stop() }
})
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

it('does not let a delayed interruption cancel a newer response on the same connection', async () => {
  const s = recoveryFixture()
  try {
    await s.voice.start()
    s.emit(0, { type: 'response.output_audio.delta', response_id: 'old', delta: 'AQACAA==' })
    s.worklets[0].holdClears = true
    const interrupting = s.voice.interrupt()
    s.emit(0, { type: 'response.output_audio.delta', response_id: 'new', delta: 'AQACAA==' })
    s.worklets[0].acknowledgeClear(); await interrupting
    expect(s.invoke.mock.calls.filter(([channel]) => channel === 'voice.nativeCancel')).toHaveLength(0)
    expect(s.voice.getDiagnostics()).toMatchObject({ clearRequests: 1, clearAcks: 1, clearTimeouts: 0 })
    s.worklets[0].holdClears = false
  } finally { await s.voice.stop() }
})
it('does not let an old clear acknowledgement cancel a replacement connection', async () => {
  const s = recoveryFixture()
  try {
    await s.voice.start()
    s.emit(0, { type: 'response.output_audio.delta', response_id: 'old', delta: 'AQACAA==' })
    const old = s.worklets[0]; old.holdClears = true
    const interrupting = s.voice.interrupt()
    s.emit(0, { type: 'closed', code: 'MEMORY_CONTEXT_REFRESH_REQUIRED' })
    const interruptRequest = old.pendingClears.shift()
    old.acknowledgeClear()
    await vi.waitFor(() => expect(s.starts()).toHaveLength(2))
    old.port.onmessage?.({ data: { type: 'cleared', requestId: interruptRequest } })
    await interrupting
    expect(s.invoke.mock.calls.filter(([channel]) => channel === 'voice.nativeCancel')).toHaveLength(0)
    expect(s.voice.active.value).toBe(true)
  } finally { await s.voice.stop() }
})
it('rebuilds an unexpectedly closed service session and stops capture when the worklet crashes', async () => {
  const s = recoveryFixture()
  try {
    await s.voice.start(); s.emit(0, { type: 'closed', code: 'REALTIME_SESSION_CLOSED' })
    await vi.waitFor(() => expect(s.starts()).toHaveLength(2))
    await vi.waitFor(() => expect(s.voice.active.value).toBe(true))
    expect(s.voice.getDiagnostics().connectionRebuilds).toBe(1)
    s.worklets[1].onprocessorerror?.()
    await vi.waitFor(() => expect(s.trackStops[1]).toHaveBeenCalledOnce())
    expect(s.voice.active.value).toBe(false)
    expect(s.voice.getDiagnostics().lastError).toBe('REALTIME_AUDIO_PROCESSOR_FAILED')
    expect(s.onError).toHaveBeenCalledWith(expect.stringContaining('语音处理已停止'))
  } finally { await s.voice.stop() }
})
