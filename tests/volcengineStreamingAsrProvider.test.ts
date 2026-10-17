import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  buildVolcengineAsrAudioRequest,
  buildVolcengineAsrFullClientRequest,
  createVolcengineStreamingAsrProvider,
  decodeVolcengineAsrResponse,
  VolcengineStreamingAsrError,
  type VolcengineWebSocketLike
} from '../electron/main/providers/volcengineStreamingAsrProvider'

class FakeWebSocket implements VolcengineWebSocketLike {
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

function makeServerResponse(text: string, flags = 0b0001): ArrayBuffer {
  const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text } })))
  const message = Buffer.alloc(12 + payload.byteLength)

  message[0] = 0x11
  message[1] = (0b1001 << 4) | flags
  message[2] = 0x11
  message[3] = 0x00
  message.writeInt32BE(1, 4)
  message.writeUInt32BE(payload.byteLength, 8)
  payload.copy(message, 12)

  return Uint8Array.from(message).buffer
}

function makeMalformedJsonServerResponse(): ArrayBuffer {
  const payload = Buffer.from('z{"error":"bad api response"}')
  const message = Buffer.alloc(8 + payload.byteLength)

  message[0] = 0x11
  message[1] = 0x90
  message[2] = 0x10
  message[3] = 0x00
  message.writeUInt32BE(payload.byteLength, 4)
  payload.copy(message, 8)

  return Uint8Array.from(message).buffer
}

function makeServerEventResponse(): ArrayBuffer {
  const requestId = Buffer.from('1c17f91c-37b8-41a5-8b4e-5e7145981eaf')
  const payload = Buffer.from('{}')
  const message = Buffer.alloc(4 + 4 + 4 + requestId.byteLength + 4 + payload.byteLength)

  message[0] = 0x11
  message[1] = 0x94
  message[2] = 0x10
  message[3] = 0x00
  message.writeUInt32BE(152, 4)
  message.writeUInt32BE(requestId.byteLength, 8)
  requestId.copy(message, 12)
  message.writeUInt32BE(payload.byteLength, 12 + requestId.byteLength)
  payload.copy(message, 16 + requestId.byteLength)

  return Uint8Array.from(message).buffer
}

describe('Volcengine streaming ASR protocol', () => {
  it('builds a gzip JSON full client request frame', () => {
    const frame = Buffer.from(
      buildVolcengineAsrFullClientRequest({
        audio: {
          format: 'pcm',
          rate: 16000
        },
        request: {
          model_name: 'bigmodel'
        },
        user: {
          uid: 'lingmo'
        }
      })
    )
    const decoded = decodeVolcengineAsrResponse(frame)

    expect(frame.subarray(0, 4)).toEqual(Buffer.from([0x11, 0x10, 0x11, 0x00]))
    expect(decoded.payload).toMatchObject({
      audio: {
        format: 'pcm',
        rate: 16000
      },
      request: {
        model_name: 'bigmodel'
      },
      user: {
        uid: 'lingmo'
      }
    })
  })

  it('marks the last audio packet with the negative-packet flag', () => {
    const frame = Buffer.from(buildVolcengineAsrAudioRequest(new ArrayBuffer(4), true))

    expect(frame.subarray(0, 4)).toEqual(Buffer.from([0x11, 0x22, 0x01, 0x00]))
  })

  it('decodes gzip JSON server responses with sequence', () => {
    const decoded = decodeVolcengineAsrResponse(makeServerResponse('你好，lingmo'))

    expect(decoded).toMatchObject({
      flags: 0b0001,
      messageType: 0b1001,
      payload: {
        result: {
          text: '你好，lingmo'
        }
      },
      sequence: 1
    })
  })

  it('decodes server event frames without treating request id bytes as JSON', () => {
    const decoded = decodeVolcengineAsrResponse(makeServerEventResponse())

    expect(decoded).toMatchObject({
      event: 152,
      flags: 0b0100,
      messageType: 0b1001,
      payload: {},
      requestId: '1c17f91c-37b8-41a5-8b4e-5e7145981eaf'
    })
  })
})

describe('Volcengine streaming ASR provider', () => {
  it('opens a websocket with official headers and sends start/audio/finish frames', async () => {
    const socket = new FakeWebSocket()
    const webSocketFactory = vi.fn(async () => socket)
    const provider = createVolcengineStreamingAsrProvider({
      env: {
        VOLCENGINE_STREAM_ASR_API_KEY: 'api-key',
        VOLCENGINE_STREAM_ASR_ENDPOINT: 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
        VOLCENGINE_STREAM_ASR_RESOURCE_ID: 'volc.bigasr.sauc.duration',
        VOLCENGINE_STREAM_ASR_UID: 'lingmo-test'
      },
      randomUUID: () => 'connect-id-1',
      webSocketFactory
    })

    const startPromise = provider.start({ sampleRate: 16000 })
    await vi.waitFor(() => {
      expect(socket.listeners.get('open')?.length).toBeGreaterThan(0)
    })
    socket.emit('open')
    const started = await startPromise

    expect(started).toEqual({
      sessionId: 'connect-id-1'
    })
    expect(webSocketFactory).toHaveBeenCalledWith(
      'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
      {
        headers: {
          'X-Api-Connect-Id': 'connect-id-1',
          'X-Api-Key': 'api-key',
          'X-Api-Resource-Id': 'volc.bigasr.sauc.duration'
        }
      }
    )
    expect(socket.sent).toHaveLength(1)

    await provider.pushAudio({
      audio: new ArrayBuffer(8),
      sessionId: 'connect-id-1'
    })
    socket.emit('message', { data: makeServerResponse('我听见了') })

    expect(socket.sent).toHaveLength(2)
    await expect(provider.stop({ sessionId: 'connect-id-1' })).resolves.toEqual({
      text: '我听见了'
    })
    expect(socket.sent).toHaveLength(3)
  })

  it('fails clearly when credentials are missing', async () => {
    const provider = createVolcengineStreamingAsrProvider({
      env: {},
      webSocketFactory: vi.fn()
    })

    await expect(provider.start({})).rejects.toThrow(VolcengineStreamingAsrError)
  })

  it('times out instead of hanging when the websocket never opens', async () => {
    const socket = new FakeWebSocket()
    const provider = createVolcengineStreamingAsrProvider({
      env: {
        VOLCENGINE_STREAM_ASR_API_KEY: 'api-key'
      },
      timeoutMs: 1,
      webSocketFactory: vi.fn(async () => socket)
    })

    await expect(provider.start({})).rejects.toMatchObject({
      code: 'REALTIME_ASR_TIMEOUT'
    })
  })

  it('turns malformed server frames into a recoverable session error', async () => {
    const socket = new FakeWebSocket()
    const provider = createVolcengineStreamingAsrProvider({
      env: {
        VOLCENGINE_STREAM_ASR_API_KEY: 'api-key'
      },
      randomUUID: () => 'connect-id-1',
      webSocketFactory: vi.fn(async () => socket)
    })

    const startPromise = provider.start({})
    await vi.waitFor(() => {
      expect(socket.listeners.get('open')?.length).toBeGreaterThan(0)
    })
    socket.emit('open')
    await startPromise
    socket.emit('message', { data: makeMalformedJsonServerResponse() })

    await expect(provider.stop({ sessionId: 'connect-id-1' })).rejects.toMatchObject({
      code: 'REALTIME_ASR_SERVER_ERROR',
      message: '实时语音识别服务返回了无法解析的数据，请稍后再试。'
    })
  })

  it('ignores server event frames while stopping an empty recognition session', async () => {
    const socket = new FakeWebSocket()
    const provider = createVolcengineStreamingAsrProvider({
      env: {
        VOLCENGINE_STREAM_ASR_API_KEY: 'api-key'
      },
      randomUUID: () => 'connect-id-1',
      webSocketFactory: vi.fn(async () => socket)
    })

    const startPromise = provider.start({})
    await vi.waitFor(() => {
      expect(socket.listeners.get('open')?.length).toBeGreaterThan(0)
    })
    socket.emit('open')
    await startPromise
    socket.emit('message', { data: makeServerEventResponse() })

    await expect(provider.stop({ sessionId: 'connect-id-1' })).resolves.toEqual({
      text: ''
    })
  })
})
