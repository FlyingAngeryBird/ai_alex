export enum VolcengineTtsMessageType {
  FullClientRequest = 0b0001,
  AudioOnlyClient = 0b0010,
  FullServerResponse = 0b1001,
  AudioOnlyServer = 0b1011,
  FrontEndResultServer = 0b1100,
  Error = 0b1111
}

export enum VolcengineTtsMessageFlag {
  NoSeq = 0,
  PositiveSeq = 0b0001,
  LastNoSeq = 0b0010,
  NegativeSeq = 0b0011,
  WithEvent = 0b0100
}

export enum VolcengineTtsEventType {
  StartConnection = 1,
  FinishConnection = 2,
  ConnectionStarted = 50,
  ConnectionFailed = 51,
  ConnectionFinished = 52,
  StartSession = 100,
  CancelSession = 101,
  FinishSession = 102,
  SessionStarted = 150,
  SessionCanceled = 151,
  SessionFinished = 152,
  SessionFailed = 153,
  TaskRequest = 200,
  TTSResponse = 352,
  TTSSubtitle = 364
}

type Payload = ArrayBuffer | Record<string, unknown>

type BuildTtsMessagePayload = {
  connectId?: string
  event: VolcengineTtsEventType
  flag?: VolcengineTtsMessageFlag
  messageType?: VolcengineTtsMessageType
  payload: Payload
  serialization?: 'json' | 'raw'
  sessionId?: string
}

export type DecodedVolcengineTtsMessage = {
  connectId: string
  errorCode?: number
  event: VolcengineTtsEventType | number
  flag: VolcengineTtsMessageFlag
  messageType: VolcengineTtsMessageType
  payload: unknown
  sequence?: number
  sessionId: string
}

const PROTOCOL_VERSION = 1
const HEADER_SIZE = 1
const SERIALIZATION_RAW = 0
const SERIALIZATION_JSON = 1
const COMPRESSION_NONE = 0

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return Uint8Array.from(buffer).buffer
}

function normalizeBuffer(data: ArrayBuffer | Buffer | Uint8Array): Buffer {
  if (Buffer.isBuffer(data)) {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data)
  }

  return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
}

function encodePayload(payload: Payload, serialization: 'json' | 'raw'): Buffer {
  if (serialization === 'raw') {
    return normalizeBuffer(payload as ArrayBuffer)
  }

  return Buffer.from(JSON.stringify(payload))
}

function writeInt32(value: number): Buffer {
  const buffer = Buffer.alloc(4)

  buffer.writeInt32BE(value, 0)
  return buffer
}

function writeUInt32(value: number): Buffer {
  const buffer = Buffer.alloc(4)

  buffer.writeUInt32BE(value, 0)
  return buffer
}

function writeString(value: string): Buffer {
  const content = Buffer.from(value)

  return Buffer.concat([writeUInt32(content.byteLength), content])
}

function eventSkipsSessionId(event: number): boolean {
  return [
    VolcengineTtsEventType.StartConnection,
    VolcengineTtsEventType.FinishConnection,
    VolcengineTtsEventType.ConnectionStarted,
    VolcengineTtsEventType.ConnectionFailed,
    VolcengineTtsEventType.ConnectionFinished
  ].includes(event)
}

function eventReadsConnectId(event: number): boolean {
  return [
    VolcengineTtsEventType.ConnectionStarted,
    VolcengineTtsEventType.ConnectionFailed,
    VolcengineTtsEventType.ConnectionFinished
  ].includes(event)
}

function hasSequence(flag: VolcengineTtsMessageFlag): boolean {
  return flag === VolcengineTtsMessageFlag.PositiveSeq || flag === VolcengineTtsMessageFlag.NegativeSeq
}

function decodePayload(payload: Buffer, serialization: number): unknown {
  if (serialization === SERIALIZATION_JSON) {
    return JSON.parse(payload.toString('utf8'))
  }

  return toArrayBuffer(payload)
}

export function buildVolcengineTtsMessage(payload: BuildTtsMessagePayload): ArrayBuffer {
  const serialization = payload.serialization ?? 'json'
  const payloadBuffer = encodePayload(payload.payload, serialization)
  const messageType = payload.messageType ?? VolcengineTtsMessageType.FullClientRequest
  const flag = payload.flag ?? VolcengineTtsMessageFlag.WithEvent
  const frameParts: Buffer[] = [
    Buffer.from([
      (PROTOCOL_VERSION << 4) | HEADER_SIZE,
      (messageType << 4) | flag,
      ((serialization === 'json' ? SERIALIZATION_JSON : SERIALIZATION_RAW) << 4) | COMPRESSION_NONE,
      0x00
    ])
  ]

  if (flag === VolcengineTtsMessageFlag.WithEvent) {
    frameParts.push(writeInt32(payload.event))

    if (!eventSkipsSessionId(payload.event)) {
      frameParts.push(writeString(payload.sessionId ?? ''))
    }

    if (eventReadsConnectId(payload.event)) {
      frameParts.push(writeString(payload.connectId ?? ''))
    }
  }

  frameParts.push(writeUInt32(payloadBuffer.byteLength), payloadBuffer)

  return toArrayBuffer(Buffer.concat(frameParts))
}

export function decodeVolcengineTtsMessage(data: ArrayBuffer | Buffer | Uint8Array): DecodedVolcengineTtsMessage {
  const message = normalizeBuffer(data)
  const headerSize = (message[0] & 0x0f) * 4
  const messageType = message[1] >> 4
  const flag = message[1] & 0x0f
  const serialization = message[2] >> 4
  let offset = headerSize
  let connectId = ''
  let errorCode: number | undefined
  let event: number = 0
  let sequence: number | undefined
  let sessionId = ''

  if (hasSequence(flag)) {
    sequence = message.readInt32BE(offset)
    offset += 4
  }

  if (messageType === VolcengineTtsMessageType.Error) {
    errorCode = message.readUInt32BE(offset)
    offset += 4
  }

  if (flag === VolcengineTtsMessageFlag.WithEvent) {
    event = message.readInt32BE(offset)
    offset += 4

    if (!eventSkipsSessionId(event)) {
      const sessionIdSize = message.readUInt32BE(offset)
      offset += 4
      sessionId = message.subarray(offset, offset + sessionIdSize).toString('utf8')
      offset += sessionIdSize
    }

    if (eventReadsConnectId(event)) {
      const connectIdSize = message.readUInt32BE(offset)
      offset += 4
      connectId = message.subarray(offset, offset + connectIdSize).toString('utf8')
      offset += connectIdSize
    }
  }

  const payloadSize = message.readUInt32BE(offset)
  offset += 4
  const rawPayload = message.subarray(offset, offset + payloadSize)

  return {
    connectId,
    errorCode,
    event,
    flag,
    messageType,
    payload: decodePayload(rawPayload, serialization),
    sequence,
    sessionId
  }
}
