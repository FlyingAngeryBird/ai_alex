import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRealtimeVoiceRecorder } from '../src/composables/useRealtimeVoiceRecorder'
import type { AppResult, LingliChannel } from '../src/types/electron-api'

type ProcessEvent = {
  inputBuffer: {
    getChannelData(channel: number): Float32Array
  }
}

class FakeProcessor {
  onaudioprocess: ((event: ProcessEvent) => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()

  emit(samples: Float32Array): void {
    this.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => samples
      }
    })
  }
}

class FakeAudioContext {
  destination = {}
  processor = new FakeProcessor()
  sampleRate = 16000
  close = vi.fn(async () => undefined)
  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn()
  }))
  createScriptProcessor = vi.fn(() => this.processor)
}

describe('realtime voice recorder', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('streams pcm chunks to realtime ASR and returns final text', async () => {
    const audioContext = new FakeAudioContext()
    const fakeTrack = {
      stop: vi.fn()
    }
    const fakeStream = {
      getTracks: () => [fakeTrack]
    } as unknown as MediaStream
    const getUserMedia = vi.fn(async () => fakeStream)
    const invokeCalls: Array<[LingliChannel, unknown]> = []
    const invoke = async <T>(channel: LingliChannel, payload?: unknown): Promise<AppResult<T>> => {
      invokeCalls.push([channel, payload])

      if (channel === 'voice.startRealtime') {
        return {
          ok: true,
          data: {
            sessionId: 'asr-session-1'
          } as T
        }
      }

      if (channel === 'voice.stopRealtime') {
        return {
          ok: true,
          data: {
            text: '你好 lingmo'
          } as T
        }
      }

      return {
        ok: true,
        data: {} as T
      }
    }
    const recorder = useRealtimeVoiceRecorder({
      createAudioContext: () => audioContext as unknown as AudioContext,
      lingli: {
        invoke
      },
      mediaDevices: {
        getUserMedia
      }
    })

    await recorder.start()
    audioContext.processor.emit(new Float32Array(4096).fill(0.2))
    await recorder.flush()
    const result = await recorder.stopAndTranscribe()

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true
      }
    })
    expect(invokeCalls[0]).toEqual(['voice.startRealtime', { sampleRate: 16000 }])
    expect(invokeCalls.some(([channel]) => channel === 'voice.pushRealtimeAudio')).toBe(true)
    expect(invokeCalls.at(-1)).toEqual(['voice.stopRealtime', { sessionId: 'asr-session-1' }])
    expect(result).toEqual({
      text: '你好 lingmo'
    })
    expect(fakeTrack.stop).toHaveBeenCalledTimes(1)
    expect(audioContext.close).toHaveBeenCalledTimes(1)
  })

  it('sends initial buffered pcm before live microphone chunks', async () => {
    const audioContext = new FakeAudioContext()
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }]
    } as unknown as MediaStream
    const initialAudio = new Int16Array([1, 2, 3, 4]).buffer
    const invokeCalls: Array<[LingliChannel, unknown]> = []
    const invoke = async <T>(channel: LingliChannel, payload?: unknown): Promise<AppResult<T>> => {
      invokeCalls.push([channel, payload])

      if (channel === 'voice.startRealtime') {
        return {
          ok: true,
          data: {
            sessionId: 'asr-session-1'
          } as T
        }
      }

      if (channel === 'voice.stopRealtime') {
        return {
          ok: true,
          data: {
            text: '开头没有丢'
          } as T
        }
      }

      return {
        ok: true,
        data: {} as T
      }
    }
    const recorder = useRealtimeVoiceRecorder({
      createAudioContext: () => audioContext as unknown as AudioContext,
      lingli: {
        invoke
      },
      mediaDevices: {
        getUserMedia: vi.fn(async () => fakeStream)
      }
    })

    await recorder.start({ initialAudio })
    audioContext.processor.emit(new Float32Array(4096).fill(0.2))
    await recorder.flush()
    await recorder.stopAndTranscribe()

    const pushCalls = invokeCalls.filter(([channel]) => channel === 'voice.pushRealtimeAudio')
    expect(pushCalls.length).toBeGreaterThanOrEqual(2)
    expect((pushCalls[0][1] as { audio: ArrayBuffer }).audio).toBe(initialAudio)
    expect((pushCalls[0][1] as { sessionId: string }).sessionId).toBe('asr-session-1')
  })

  it('can reuse an external microphone stream without stopping it on cleanup', async () => {
    const audioContext = new FakeAudioContext()
    const fakeTrack = {
      stop: vi.fn()
    }
    const externalStream = {
      getTracks: () => [fakeTrack]
    } as unknown as MediaStream
    const getUserMedia = vi.fn()
    const invoke = async <T>(channel: LingliChannel): Promise<AppResult<T>> => {
      if (channel === 'voice.startRealtime') {
        return {
          ok: true,
          data: {
            sessionId: 'asr-session-1'
          } as T
        }
      }

      if (channel === 'voice.stopRealtime') {
        return {
          ok: true,
          data: {
            text: '没有二次开麦'
          } as T
        }
      }

      return {
        ok: true,
        data: {} as T
      }
    }
    const recorder = useRealtimeVoiceRecorder({
      createAudioContext: () => audioContext as unknown as AudioContext,
      lingli: {
        invoke
      },
      mediaDevices: {
        getUserMedia
      }
    })

    await recorder.start({ stream: externalStream })
    const result = await recorder.stopAndTranscribe()

    expect(result.text).toBe('没有二次开麦')
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(audioContext.createMediaStreamSource).toHaveBeenCalledWith(externalStream)
    expect(fakeTrack.stop).not.toHaveBeenCalled()
    expect(audioContext.close).toHaveBeenCalledTimes(1)
  })

  it('cleans up the microphone stream when realtime ASR stop fails', async () => {
    const audioContext = new FakeAudioContext()
    const fakeTrack = {
      stop: vi.fn()
    }
    const fakeStream = {
      getTracks: () => [fakeTrack]
    } as unknown as MediaStream
    const invoke = async <T>(channel: LingliChannel): Promise<AppResult<T>> => {
      if (channel === 'voice.startRealtime') {
        return {
          ok: true,
          data: {
            sessionId: 'asr-session-1'
          } as T
        }
      }

      if (channel === 'voice.stopRealtime') {
        throw new Error('网络断开')
      }

      return {
        ok: true,
        data: {} as T
      }
    }
    const recorder = useRealtimeVoiceRecorder({
      createAudioContext: () => audioContext as unknown as AudioContext,
      lingli: {
        invoke
      },
      mediaDevices: {
        getUserMedia: vi.fn(async () => fakeStream)
      }
    })

    await recorder.start()
    await expect(recorder.stopAndTranscribe()).rejects.toThrow('网络断开')

    expect(recorder.isRecording.value).toBe(false)
    expect(fakeTrack.stop).toHaveBeenCalledTimes(1)
    expect(audioContext.close).toHaveBeenCalledTimes(1)
  })

  it('cleans up the microphone stream when realtime ASR start fails after permission is granted', async () => {
    const audioContext = new FakeAudioContext()
    const fakeTrack = {
      stop: vi.fn()
    }
    const fakeStream = {
      getTracks: () => [fakeTrack]
    } as unknown as MediaStream
    const invoke = async <T>(): Promise<AppResult<T>> => ({
      ok: false,
      error: {
        code: 'REALTIME_ASR_FAILED',
        message: '实时识别服务不可用'
      }
    })
    const recorder = useRealtimeVoiceRecorder({
      createAudioContext: () => audioContext as unknown as AudioContext,
      lingli: {
        invoke
      },
      mediaDevices: {
        getUserMedia: vi.fn(async () => fakeStream)
      }
    })

    await expect(recorder.start()).rejects.toThrow('实时识别服务不可用')

    expect(recorder.isRecording.value).toBe(false)
    expect(fakeTrack.stop).toHaveBeenCalledTimes(1)
    expect(audioContext.close).toHaveBeenCalledTimes(1)
  })

  it('cleans up when local audio graph creation fails after ASR session starts', async () => {
    const audioContext = new FakeAudioContext()
    audioContext.createMediaStreamSource.mockImplementation(() => {
      throw new Error('无法连接麦克风音频流')
    })
    const fakeTrack = {
      stop: vi.fn()
    }
    const fakeStream = {
      getTracks: () => [fakeTrack]
    } as unknown as MediaStream
    const invoke = async <T>(): Promise<AppResult<T>> => ({
      ok: true,
      data: {
        sessionId: 'asr-session-1'
      } as T
    })
    const recorder = useRealtimeVoiceRecorder({
      createAudioContext: () => audioContext as unknown as AudioContext,
      lingli: {
        invoke
      },
      mediaDevices: {
        getUserMedia: vi.fn(async () => fakeStream)
      }
    })

    await expect(recorder.start()).rejects.toThrow('无法连接麦克风音频流')

    expect(recorder.isRecording.value).toBe(false)
    expect(fakeTrack.stop).toHaveBeenCalledTimes(1)
    expect(audioContext.close).toHaveBeenCalledTimes(1)
  })

  it('closes the realtime ASR session when local audio graph creation fails after start', async () => {
    const audioContext = new FakeAudioContext()
    audioContext.createMediaStreamSource.mockImplementation(() => {
      throw new Error('无法连接麦克风音频流')
    })
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }]
    } as unknown as MediaStream
    const invokeCalls: Array<[LingliChannel, unknown]> = []
    const invoke = async <T>(channel: LingliChannel, payload?: unknown): Promise<AppResult<T>> => {
      invokeCalls.push([channel, payload])

      if (channel === 'voice.startRealtime') {
        return {
          ok: true,
          data: {
            sessionId: 'asr-session-1'
          } as T
        }
      }

      if (channel === 'voice.stopRealtime') {
        return {
          ok: true,
          data: {
            text: ''
          } as T
        }
      }

      return {
        ok: true,
        data: {} as T
      }
    }
    const recorder = useRealtimeVoiceRecorder({
      createAudioContext: () => audioContext as unknown as AudioContext,
      lingli: {
        invoke
      },
      mediaDevices: {
        getUserMedia: vi.fn(async () => fakeStream)
      }
    })

    await expect(recorder.start()).rejects.toThrow('无法连接麦克风音频流')

    expect(invokeCalls).toContainEqual(['voice.stopRealtime', { sessionId: 'asr-session-1' }])
  })

  it('closes the realtime ASR session when queued audio push fails during stop', async () => {
    const audioContext = new FakeAudioContext()
    const fakeTrack = {
      stop: vi.fn()
    }
    const fakeStream = {
      getTracks: () => [fakeTrack]
    } as unknown as MediaStream
    const invokeCalls: Array<[LingliChannel, unknown]> = []
    const invoke = async <T>(channel: LingliChannel, payload?: unknown): Promise<AppResult<T>> => {
      invokeCalls.push([channel, payload])

      if (channel === 'voice.startRealtime') {
        return {
          ok: true,
          data: {
            sessionId: 'asr-session-1'
          } as T
        }
      }

      if (channel === 'voice.pushRealtimeAudio') {
        throw new Error('推送音频失败')
      }

      if (channel === 'voice.stopRealtime') {
        return {
          ok: true,
          data: {
            text: ''
          } as T
        }
      }

      return {
        ok: true,
        data: {} as T
      }
    }
    const recorder = useRealtimeVoiceRecorder({
      createAudioContext: () => audioContext as unknown as AudioContext,
      lingli: {
        invoke
      },
      mediaDevices: {
        getUserMedia: vi.fn(async () => fakeStream)
      }
    })

    await recorder.start()
    audioContext.processor.emit(new Float32Array(4096).fill(0.2))
    await expect(recorder.stopAndTranscribe()).rejects.toThrow('推送音频失败')

    expect(invokeCalls).toContainEqual(['voice.stopRealtime', { sessionId: 'asr-session-1' }])
    expect(fakeTrack.stop).toHaveBeenCalledTimes(1)
    expect(audioContext.close).toHaveBeenCalledTimes(1)
  })

  it('forwards partial transcripts via onPartialText and clears on cleanup', async () => {
    const audioContext = new FakeAudioContext()
    const fakeStream = {
      getTracks: () => [{ stop: vi.fn() }]
    } as unknown as MediaStream
    const partials: string[] = []
    const invoke = async <T>(channel: LingliChannel): Promise<AppResult<T>> => {
      if (channel === 'voice.startRealtime') {
        return { ok: true, data: { sessionId: 'asr-session-1' } as T }
      }
      if (channel === 'voice.pushRealtimeAudio') {
        return { ok: true, data: { partialText: '你好' } as T }
      }
      if (channel === 'voice.stopRealtime') {
        return { ok: true, data: { text: '你好 lingmo' } as T }
      }
      return { ok: true, data: {} as T }
    }
    const recorder = useRealtimeVoiceRecorder({
      createAudioContext: () => audioContext as unknown as AudioContext,
      lingli: { invoke },
      mediaDevices: { getUserMedia: vi.fn(async () => fakeStream) },
      onPartialText: (text) => partials.push(text)
    })

    await recorder.start()
    audioContext.processor.emit(new Float32Array(4096).fill(0.2))
    await recorder.flush()
    await recorder.stopAndTranscribe()

    expect(partials).toContain('你好')
    expect(partials.at(-1)).toBe('')
  })
})
