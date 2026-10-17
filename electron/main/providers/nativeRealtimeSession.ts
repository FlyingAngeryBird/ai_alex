import { randomUUID } from 'node:crypto'
import WebSocket, { type ClientOptions } from 'ws'
import type { R1ModelRequestBoundary } from '../r1/modelBoundary.js'
import { NATIVE_REALTIME_ENDPOINT, NativeRealtimeError, nativeSessionCreate, nativeFailureCode } from './nativeRealtimeProvider.js'

export type NativeRealtimeEvent = Record<string, unknown> & { type: string }
export type NativeToolCall = { callId: string; name: string; arguments: unknown }
/** Live duplex transport. Domain actions and playback remain owned by the application. */
export class NativeRealtimeSession {
  private diagnostic = { serverAudioFrames: 0, serverAudioBytes: 0, discardedCancelledAudio: 0,
    serverAsrDeltas: 0, serverAsrCompleted: 0, serverAsrWithTranscript: 0, serverAsrWithItemId: 0 }
  getDiagnostics() { return { ...this.diagnostic } }
  private socket: WebSocket | null = null
  private state: 'new' | 'connecting' | 'ready' | 'closed' = 'new'
  private pendingCalls = new Map<string, NativeToolCall>()
  private answeredCalls = new Set<string>()
  private cancelledResponses = new Set<string>()
  private activeResponse: string | null = null
  private finishOpening: ((error?: string) => void) | null = null
  private timeout: ReturnType<typeof setTimeout> | null = null
  constructor(private readonly input: {
    apiKey: string; voice: string; boundary: R1ModelRequestBoundary;
    onEvent: (event: NativeRealtimeEvent) => void;
    onToolCalls: (calls: NativeToolCall[]) => void;
    onClosed: (code: string) => void;
    connect?: (url: string, options: ClientOptions) => WebSocket;
  }) {}

  open(): Promise<void> {
    if (this.state !== 'new') return Promise.reject(new NativeRealtimeError('REALTIME_ALREADY_STARTED'))
    if (!this.input.apiKey.trim()) return Promise.reject(new NativeRealtimeError('REALTIME_NOT_CONFIGURED'))
    if (/[\r\n\x00]/.test(this.input.apiKey)) {
      return Promise.reject(new NativeRealtimeError('REALTIME_CONFIG_INVALID'))
    }
    const create = nativeSessionCreate(this.input.boundary, this.input.voice)
    this.state = 'connecting'
    return new Promise((resolve, reject) => {
      this.finishOpening = code => {
        if (this.timeout) clearTimeout(this.timeout)
        this.timeout = null; this.finishOpening = null
        if (code) reject(new NativeRealtimeError(code)); else resolve()
      }
      this.timeout = setTimeout(() => this.close('REALTIME_START_TIMEOUT'), 10000)
      try {
        const socket = this.socket = (this.input.connect ?? ((url, options) => new WebSocket(url, options)))(
          NATIVE_REALTIME_ENDPOINT, { headers: { 'X-Api-Key': this.input.apiKey.trim() },
            handshakeTimeout: 10000, maxPayload: 1_048_576, followRedirects: false })
        socket.on('open', () => {
          if (this.state !== 'connecting') return
          try { this.input.boundary.assertCurrent(); socket.send(JSON.stringify(create)) }
          catch { this.close('REALTIME_CONTEXT_INVALIDATED') }
        })
        socket.on('message', (data, binary) => {
          if (this.state === 'closed') return
          try {
            this.input.boundary.assertCurrent()
            if (binary) throw new Error('binary')
            const event: unknown = JSON.parse(data.toString())
            if (!event || typeof event !== 'object' || typeof (event as NativeRealtimeEvent).type !== 'string') throw new Error('event')
            this.receive(event as NativeRealtimeEvent)
          } catch { this.close('REALTIME_PROTOCOL_OR_CONTEXT_INVALID') }
        })
        socket.on('unexpected-response', (_request, response) => {
          response.resume()
          this.close(nativeFailureCode(response.statusCode, 'http'))
        })
        socket.on('error', () => this.close('REALTIME_NETWORK_FAILED'))
        socket.on('close', () => this.close('REALTIME_CONNECTION_CLOSED'))
      } catch { this.close('REALTIME_NETWORK_FAILED') }
    })
  }
  private send(event: NativeRealtimeEvent): void {
    if (this.state !== 'ready' || !this.socket) throw new NativeRealtimeError('REALTIME_NOT_READY')
    this.input.boundary.assertCurrent()
    if (this.socket.bufferedAmount > 262144) { this.close('REALTIME_UPLINK_CONGESTED'); throw new NativeRealtimeError('REALTIME_UPLINK_CONGESTED') }
    this.socket.send(JSON.stringify({ event_id: randomUUID(), ...event }))
  }
  updateBoundary(boundary: R1ModelRequestBoundary): void {
    this.send({ ...nativeSessionCreate(boundary, this.input.voice), type: 'session.update' })
    this.input.boundary = boundary
  }
  appendAudio(pcm: Uint8Array): void {
    // 16 kHz mono signed PCM16; no unbounded queue when disconnected.
    if (!pcm.byteLength || pcm.byteLength > 32000 || pcm.byteLength % 2) throw new NativeRealtimeError('REALTIME_AUDIO_INVALID')
    this.send({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') })
  }
  setMuted(muted: boolean): void { this.send({ type: muted ? 'input_audio_mute.commit' : 'input_audio_unmute.commit' }) }
  commitAudio(): void { this.send({ type: 'input_audio_buffer.commit' }) }
  cancelResponse(): string | null {
    const id = this.activeResponse
    if (id) this.cancelledResponses.add(id)
    this.send({ type: 'response.cancel' })
    this.activeResponse = null
    return id
  }
  returnToolResult(callId: string, result: unknown): void {
    if (!this.pendingCalls.has(callId)) throw new NativeRealtimeError('REALTIME_TOOL_CALL_UNKNOWN')
    const text = JSON.stringify(result)
    if (typeof text !== 'string' || text.length > 65536) throw new NativeRealtimeError('REALTIME_TOOL_RESULT_INVALID')
    this.send({ type: 'conversation.item.create', items: [{ role: 'tool', call_id: callId,
      content: [{ type: 'input_text', text }] }] })
    this.pendingCalls.delete(callId); this.answeredCalls.add(callId)
  }
  private receive(event: NativeRealtimeEvent): void {
    if (event.type === 'response.output_audio.delta') {
      this.diagnostic.serverAudioFrames++
      if (typeof event.delta === 'string') this.diagnostic.serverAudioBytes += Math.floor(event.delta.length * 3 / 4) - (event.delta.endsWith('==') ? 2 : event.delta.endsWith('=') ? 1 : 0)
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta') this.diagnostic.serverAsrDeltas++
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      this.diagnostic.serverAsrCompleted++
      if (typeof event.transcript === 'string') this.diagnostic.serverAsrWithTranscript++
      if (typeof event.item_id === 'string') this.diagnostic.serverAsrWithItemId++
    }
    if (event.type === 'error') {
      const error = event.error && typeof event.error === 'object' ? event.error as Record<string, unknown> : null
      this.close(nativeFailureCode(error?.code ?? event.code, 'event')); return
    }
    if (event.type === 'session.closed') { this.close('REALTIME_SESSION_CLOSED'); return }
    if (event.type === 'session.created') {
      const session = event.session as { id?: unknown } | undefined
      if (this.state !== 'connecting' || typeof session?.id !== 'string' || !session.id) throw new Error('session')
      this.state = 'ready'
      // Audio capture explicitly unmutes after it has acquired the microphone.
      this.setMuted(true)
      this.finishOpening?.()
      this.input.onEvent(event); return
    }
    if (this.state !== 'ready') throw new Error('session not ready')
    if (event.type === 'conversation.item.input_audio_transcription.started' && this.activeResponse) {
      this.cancelledResponses.add(this.activeResponse)
      this.activeResponse = null
    }
    const responseId = typeof event.response_id === 'string' ? event.response_id : null
    if (responseId && this.cancelledResponses.has(responseId)) {
      if (event.type === 'response.output_audio.delta') this.diagnostic.discardedCancelledAudio++
      return
    }
    if (responseId && event.type.startsWith('response.output_')) this.activeResponse = responseId
    if (event.type === 'response.function_call_arguments.done') {
      if (!Array.isArray(event.items) || !event.items.length || event.items.length > 6) throw new Error('calls')
      const batch = new Set<string>()
      const calls: NativeToolCall[] = event.items.map((item: Record<string, unknown>) => {
        if (!item || typeof item.call_id !== 'string' || !item.call_id || item.call_id.length > 160 ||
          typeof item.name !== 'string' || typeof item.arguments !== 'string' || item.arguments.length > 65536 ||
          batch.has(item.call_id) || this.pendingCalls.has(item.call_id) || this.answeredCalls.has(item.call_id)) throw new Error('call')
        const args: unknown = JSON.parse(item.arguments)
        this.input.boundary.validateToolCall(item.name, args)
        batch.add(item.call_id)
        return { callId: item.call_id, name: item.name, arguments: args }
      })
      // Validate the entire batch before any domain action may begin.
      for (const call of calls) this.pendingCalls.set(call.callId, call)
      this.input.onToolCalls(calls); return
    }
    if ((event.type === 'response.done' || event.type === 'response.canceled') &&
      (!responseId || responseId === this.activeResponse)) this.activeResponse = null
    this.input.onEvent(event)
  }
  close(code = 'REALTIME_STOPPED'): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.finishOpening?.(code)
    this.pendingCalls.clear(); this.answeredCalls.clear(); this.cancelledResponses.clear(); this.activeResponse = null
    // Keep error listener installed: terminating an unfinished upgrade can emit error.
    this.socket?.terminate(); this.socket = null
    this.input.onClosed(code)
  }
}
