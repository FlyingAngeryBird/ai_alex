import { afterEach, describe, expect, it, vi } from 'vitest'
import { useKeyboardRecorder } from '../src/composables/useKeyboardRecorder'
import type { AppResult, LingliChannel } from '../src/types/electron-api'

type RecorderEvent = {
  data: Blob
}

class FakeMediaRecorder {
  static instance: FakeMediaRecorder | null = null

  ondataavailable: ((event: RecorderEvent) => void) | null = null
  onstop: (() => void) | null = null
  state: RecordingState = 'inactive'

  constructor(_stream?: MediaStream) {
    FakeMediaRecorder.instance = this
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({
      data: new Blob(['hello-audio'], { type: 'audio/webm' })
    })
    this.onstop?.()
  }
}

describe('keyboard recorder', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    FakeMediaRecorder.instance = null
  })

  it('sends recorded audio to the main voice transcription channel', async () => {
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
      const audioPayload = payload as { audio: ArrayBuffer; mimeType: string }

      expect(audioPayload.audio.byteLength).toBeGreaterThan(0)
      expect(audioPayload.mimeType).toBe('audio/webm')

      return {
        ok: true,
        data: {
          text: '今天想聊聊天'
        } as T
      }
    }

    const recorder = useKeyboardRecorder({
      createMediaRecorder: (stream) => new FakeMediaRecorder(stream) as unknown as MediaRecorder,
      lingli: {
        invoke
      },
      mediaDevices: {
        getUserMedia
      }
    })

    await recorder.start()
    const result = await recorder.stopAndTranscribe()

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(invokeCalls).toHaveLength(1)
    expect(invokeCalls[0][0]).toBe('voice.stopAndTranscribe')
    expect(result).toEqual({
      text: '今天想聊聊天'
    })
    expect(recorder.isRecording.value).toBe(false)
    expect(fakeTrack.stop).toHaveBeenCalledTimes(1)
  })

  it('does not request the microphone when the desktop voice bridge is unavailable', async () => {
    const getUserMedia = vi.fn()
    const recorder = useKeyboardRecorder({
      createMediaRecorder: (stream) => new FakeMediaRecorder(stream) as unknown as MediaRecorder,
      mediaDevices: {
        getUserMedia
      }
    })

    await expect(recorder.start()).rejects.toThrow('语音通道不可用')

    expect(recorder.isRecording.value).toBe(false)
    expect(recorder.errorMessage.value).toBe('语音通道不可用')
    expect(getUserMedia).not.toHaveBeenCalled()
  })
  it('discards a cancelled recording and releases the microphone without ASR submission', async () => {
    const track = { stop: vi.fn() }
    const stream = { getTracks: () => [track] } as unknown as MediaStream
    const invoke = vi.fn()
    const recorder = useKeyboardRecorder({ createMediaRecorder: () => new FakeMediaRecorder() as unknown as MediaRecorder,
      lingli: { invoke }, mediaDevices: { getUserMedia: vi.fn(async () => stream) } })
    await recorder.start()
    recorder.cancel()
    expect(recorder.isRecording.value).toBe(false)
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalled()
    await expect(recorder.stopAndTranscribe()).rejects.toThrow('当前没有正在录制的语音')
  })
})
