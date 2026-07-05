import { describe, expect, it } from 'vitest'
import {
  buildVolcengineTtsMessage,
  decodeVolcengineTtsMessage,
  VolcengineTtsEventType,
  VolcengineTtsMessageFlag,
  VolcengineTtsMessageType
} from '../electron/main/providers/volcengineTtsProtocol'

describe('Volcengine TTS bidirectional websocket protocol', () => {
  it('builds a StartConnection event message', () => {
    const frame = Buffer.from(
      buildVolcengineTtsMessage({
        event: VolcengineTtsEventType.StartConnection,
        payload: {}
      })
    )

    expect(frame.subarray(0, 8)).toEqual(Buffer.from([0x11, 0x14, 0x10, 0x00, 0x00, 0x00, 0x00, 0x01]))
    expect(decodeVolcengineTtsMessage(frame)).toMatchObject({
      event: VolcengineTtsEventType.StartConnection,
      payload: {}
    })
  })

  it('builds a StartSession message with a session id', () => {
    const frame = buildVolcengineTtsMessage({
      event: VolcengineTtsEventType.StartSession,
      payload: {
        speaker: 'voice-id'
      },
      sessionId: 'tts-session-1'
    })

    expect(decodeVolcengineTtsMessage(frame)).toMatchObject({
      event: VolcengineTtsEventType.StartSession,
      payload: {
        speaker: 'voice-id'
      },
      sessionId: 'tts-session-1'
    })
  })

  it('decodes an audio response event as raw payload', () => {
    const audio = Uint8Array.from([1, 2, 3, 4]).buffer
    const frame = buildVolcengineTtsMessage({
      event: VolcengineTtsEventType.TTSResponse,
      flag: VolcengineTtsMessageFlag.WithEvent,
      messageType: VolcengineTtsMessageType.AudioOnlyServer,
      payload: audio,
      serialization: 'raw',
      sessionId: 'tts-session-1'
    })
    const decoded = decodeVolcengineTtsMessage(frame)

    expect(decoded.event).toBe(VolcengineTtsEventType.TTSResponse)
    expect(decoded.messageType).toBe(VolcengineTtsMessageType.AudioOnlyServer)
    expect(Buffer.from(decoded.payload as ArrayBuffer)).toEqual(Buffer.from(audio))
  })
})
