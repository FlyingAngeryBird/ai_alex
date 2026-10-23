import { describe, expect, it, vi } from 'vitest'
import {
  createVolcengineTtsProvider,
  VolcengineTtsError,
  type VolcengineTtsWebSocketLike
} from '../electron/main/providers/volcengineTtsProvider'
import {
  buildVolcengineTtsMessage,
  VolcengineTtsEventType,
  VolcengineTtsMessageType
} from '../electron/main/providers/volcengineTtsProtocol'

class FakeWebSocket implements VolcengineTtsWebSocketLike {
  binaryType = 'arraybuffer'
  sent: ArrayBuffer[] = []
  listeners = new Map<string, Array<(event?: unknown) => void>>()

  addEventListener(event: string, listener: (event?: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
  }

  close(): void {
    this.emit('close')
  }

  emit(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload)
    }
  }

  send(data: ArrayBuffer | Buffer): void {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data)
    this.sent.push(Uint8Array.from(buffer).buffer)
  }
}

function serverMessage(event: VolcengineTtsEventType, payload: Record<string, unknown> = {}, sessionId?: string): ArrayBuffer {
  return buildVolcengineTtsMessage({
    connectId: 'connect-id-1',
    event,
    messageType: VolcengineTtsMessageType.FullServerResponse,
    payload,
    sessionId
  })
}

function serverAudio(audio: ArrayBuffer, sessionId: string): ArrayBuffer {
  return buildVolcengineTtsMessage({
    event: VolcengineTtsEventType.TTSResponse,
    messageType: VolcengineTtsMessageType.AudioOnlyServer,
    payload: audio,
    serialization: 'raw',
    sessionId
  })
}

describe('Volcengine TTS provider', () => {
  it('synthesizes one reply into playable audio', async () => {
    const socket = new FakeWebSocket()
    const webSocketFactory = vi.fn(async () => socket)
    const provider = createVolcengineTtsProvider({
      env: {
        VOLCENGINE_TTS_API_KEY: 'tts-key',
        VOLCENGINE_TTS_ENDPOINT: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
        VOLCENGINE_TTS_FORMAT: 'mp3',
        VOLCENGINE_TTS_RESOURCE_ID: 'seed-icl-2.0',
        VOLCENGINE_TTS_SAMPLE_RATE: '24000',
        VOLCENGINE_TTS_VOICE: 'voice-id'
      },
      randomUUID: vi.fn()
        .mockReturnValueOnce('connect-id-1')
        .mockReturnValueOnce('session-id-1'),
      webSocketFactory
    })
    const speakPromise = provider.speak({ text: '你好，lingmo' })

    await vi.waitFor(() => {
      expect(socket.listeners.get('open')?.length).toBeGreaterThan(0)
    })
    socket.emit('open')
    socket.emit('message', { data: serverMessage(VolcengineTtsEventType.ConnectionStarted) })
    socket.emit('message', { data: serverMessage(VolcengineTtsEventType.SessionStarted, {}, 'session-id-1') })
    socket.emit('message', { data: serverAudio(Uint8Array.from([1, 2]).buffer, 'session-id-1') })
    socket.emit('message', { data: serverAudio(Uint8Array.from([3, 4]).buffer, 'session-id-1') })
    socket.emit('message', { data: serverMessage(VolcengineTtsEventType.SessionFinished, {}, 'session-id-1') })
    socket.emit('message', { data: serverMessage(VolcengineTtsEventType.ConnectionFinished) })

    await expect(speakPromise).resolves.toEqual({
      audio: Uint8Array.from([1, 2, 3, 4]).buffer,
      mimeType: 'audio/mpeg'
    })
    expect(webSocketFactory).toHaveBeenCalledWith(
      'wss://openspeech.bytedance.com/api/v3/tts/bidirection',
      {
        headers: {
          'X-Api-Connect-Id': 'connect-id-1',
          'X-Api-Key': 'tts-key',
          'X-Api-Resource-Id': 'seed-icl-2.0',
          'X-Control-Require-Usage-Tokens-Return': '*'
        }
      }
    )
    expect(socket.sent).toHaveLength(5)
  })

  it('fails clearly when TTS credentials are missing', async () => {
    const provider = createVolcengineTtsProvider({
      env: {}
    })

    await expect(provider.speak({ text: '你好' })).rejects.toThrow(VolcengineTtsError)
  })

  it('times out instead of hanging when the TTS service does not answer', async () => {
    const socket = new FakeWebSocket()
    const provider = createVolcengineTtsProvider({
      env: {
        VOLCENGINE_TTS_API_KEY: 'tts-key',
        VOLCENGINE_TTS_RESOURCE_ID: 'seed-icl-2.0',
        VOLCENGINE_TTS_VOICE: 'voice-id'
      },
      timeoutMs: 1,
      webSocketFactory: vi.fn(async () => socket)
    })

    await expect(provider.speak({ text: '你好' })).rejects.toMatchObject({
      code: 'STREAMING_TTS_TIMEOUT'
    })
  })
})
