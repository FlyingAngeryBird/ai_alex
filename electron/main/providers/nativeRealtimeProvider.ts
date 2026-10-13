import { randomUUID } from 'node:crypto'
import WebSocket, { type ClientOptions, type RawData } from 'ws'
import type { R1ModelRequestBoundary } from '../r1/modelBoundary.js'

// Official Seeduplex 3.0 JSON protocol, distinct from legacy binary realtime/dialogue.
export const NATIVE_REALTIME_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue'
export const NATIVE_REALTIME_MODEL = '1.2.6.1'
export class NativeRealtimeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'NativeRealtimeError' }
}
export function nativeSessionCreate(boundary: R1ModelRequestBoundary, voice: string): Record<string, unknown> {
  if (typeof voice !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(voice)) throw new NativeRealtimeError('REALTIME_VOICE_REQUIRED')
  const prepared = boundary.finalize([])
  return { type: 'session.create', event_id: randomUUID(), session: {
    model: NATIVE_REALTIME_MODEL, instructions: boundary.systemText,
    audio: { input: { format: { type: 'pcm', rate: 16000 } },
      output: { format: { type: 'pcm_s16le', rate: 24000 }, voice } },
    tools: prepared.tools.map(tool => ({ type: 'function', ...tool.function }))
  }, extension: { asr: {}, tts: {}, dialog: { extra: { enable_volc_websearch: false, enable_music: false } } } }
}

/** Checks session create/close only. It never opens a microphone or sends conversation text. */
export async function checkNativeRealtimeSession(input: { apiKey: string; voice: string;
  boundary: R1ModelRequestBoundary; signal?: AbortSignal }, options: {
    connect?: (url: string, options: ClientOptions) => WebSocket; timeoutMs?: number
  } = {}): Promise<{ scope: 'session_create_close'; model: string }> {
  if (!input.apiKey?.trim()) throw new NativeRealtimeError('REALTIME_NOT_CONFIGURED')
  if (/[\r\n\x00]/.test(input.apiKey)) throw new NativeRealtimeError('REALTIME_CONFIG_INVALID')
  if (input.signal?.aborted) throw new NativeRealtimeError('REALTIME_CHECK_CANCELLED')
  const create = nativeSessionCreate(input.boundary, input.voice)
  if (input.boundary.diagnostic.toolAliases.length) throw new NativeRealtimeError('REALTIME_CHECK_TOOLS_FORBIDDEN')
  return new Promise((resolve, reject) => {
    let settled = false
    let created = false
    const socket = (options.connect ?? ((url, options) => new WebSocket(url, options)))(NATIVE_REALTIME_ENDPOINT, {
      headers: { 'X-Api-Key': input.apiKey.trim() }, handshakeTimeout: options.timeoutMs ?? 10000,
      maxPayload: 1_048_576, followRedirects: false
    })
    function finish(code?: string): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', abort)
      // Keep error listener until close: terminate during HTTP upgrade may emit another error.
      socket.terminate()
      if (code) reject(new NativeRealtimeError(code))
      else resolve({ scope: 'session_create_close', model: NATIVE_REALTIME_MODEL })
    }
    function abort(): void { finish('REALTIME_CHECK_CANCELLED') }
    function send(event: Record<string, unknown>): void {
      if (settled) return
      try { socket.send(JSON.stringify(event)) } catch { finish('REALTIME_NETWORK_FAILED') }
    }
    const timeout = setTimeout(() => finish('REALTIME_CHECK_TIMEOUT'), options.timeoutMs ?? 10000)
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) { abort(); return }
    socket.on('open', () => send(create))
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (settled) return
      if (isBinary) { finish('REALTIME_PROTOCOL_INVALID'); return }
      let event: { type?: unknown; session?: { id?: unknown }; error?: { code?: unknown }; code?: unknown }
      try { event = JSON.parse(data.toString()) } catch { finish('REALTIME_PROTOCOL_INVALID'); return }
      if (!event || typeof event.type !== 'string') { finish('REALTIME_PROTOCOL_INVALID'); return }
      if (event.type === 'error') {
        // Server messages can include private request data: return a stable category only.
        const code = String(event.error?.code ?? event.code ?? '')
        finish(['401', '403', '45000001', '45000002'].includes(code) ? 'REALTIME_AUTH_FAILED' : 'REALTIME_SERVER_REJECTED')
      } else if (event.type === 'session.created') {
        if (created || typeof event.session?.id !== 'string' || !event.session.id) { finish('REALTIME_PROTOCOL_INVALID'); return }
        created = true
        send({ type: 'input_audio_mute.commit', event_id: randomUUID() })
        send({ type: 'session.close', event_id: randomUUID() })
      } else if (event.type === 'session.closed') {
        finish(created ? undefined : 'REALTIME_PROTOCOL_INVALID')
      } else if (event.type.startsWith('response.')) {
        finish('REALTIME_UNEXPECTED_RESPONSE')
      }
    })
    socket.on('unexpected-response', (_request, response) => {
      response.resume()
      finish(response.statusCode === 401 || response.statusCode === 403 ? 'REALTIME_AUTH_FAILED'
        : response.statusCode === 429 ? 'REALTIME_QUOTA_LIMIT' : 'REALTIME_UPGRADE_FAILED')
    })
    socket.on('error', () => finish('REALTIME_NETWORK_FAILED'))
    socket.on('close', () => { if (!settled) finish('REALTIME_SESSION_CLOSED_EARLY') })
  })
}
