import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import type { ClientOptions } from 'ws'
import { checkNativeRealtimeSession, nativeSessionCreate, NATIVE_REALTIME_ENDPOINT } from '../electron/main/providers/nativeRealtimeProvider'
import { R1ModelRequestBoundary } from '../electron/main/r1/modelBoundary'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { modelContext } from './helpers/r1ModelFixtures'
const assets = loadR1PromptAssets(resolve('r1-assets'))
const boundary = () => new R1ModelRequestBoundary(assets, { assistantName: 'Seamo AI',
  userAddress: '', style: '简洁', voiceId: '', version: 1 }, modelContext({ temporary: true }), [], 'realtime')
class Socket extends EventEmitter {
  sent: Record<string, unknown>[] = []
  terminate = vi.fn()
  send(value: string) { this.sent.push(JSON.parse(value)) }
  event(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false) }
}
function fixture(timeoutMs = 1000) {
  const socket = new Socket()
  const connect = vi.fn((_url: string, _options: ClientOptions) => socket as unknown as WebSocket)
  return { socket, connect, options: { connect, timeoutMs } }
}
describe('native Seeduplex 3.0 session diagnostic', () => {
  it('uses registered instructions, official JSON endpoint, PCM and disables builtins', async () => {
    const { socket, connect, options } = fixture()
    const promise = checkNativeRealtimeSession({ apiKey: 'test-key', voice: 'test_voice', boundary: boundary() }, options)
    expect(connect.mock.calls[0][0]).toBe(NATIVE_REALTIME_ENDPOINT)
    expect(connect.mock.calls[0][1].headers).toEqual({ 'X-Api-Key': 'test-key' })
    socket.emit('open')
    expect(socket.sent[0]).toMatchObject({ type: 'session.create', session: { model: '1.2.6.1', tools: [],
      audio: { input: { format: { type: 'pcm', rate: 16000 } }, output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: 'test_voice' } } },
      extension: { dialog: { extra: { enable_volc_websearch: false, enable_music: false } } } })
    expect(socket.sent[0].session).not.toHaveProperty('extension')
    socket.event({ type: 'session.created', session: { id: 'native-session' } })
    expect(socket.sent.slice(1).map(event => event.type)).toEqual(['input_audio_mute.commit', 'session.close'])
    expect(socket.sent.some(event => event.type === 'input_audio_buffer.append')).toBe(false)
    socket.event({ type: 'session.closed' })
    await expect(promise).resolves.toEqual({ scope: 'session_create_close', model: '1.2.6.1' })
    expect(socket.terminate).toHaveBeenCalledOnce()
  })
  it('requires session confirmation and orderly close instead of accepting WebSocket open', async () => {
    const { socket, options } = fixture()
    const promise = checkNativeRealtimeSession({ apiKey: 'key', voice: 'voice', boundary: boundary() }, options)
    socket.emit('open'); socket.event({ type: 'session.closed' })
    await expect(promise).rejects.toMatchObject({ code: 'REALTIME_PROTOCOL_INVALID' })
  })
  it('cancels without publishing a late session success', async () => {
    const { socket, options } = fixture()
    const controller = new AbortController()
    const promise = checkNativeRealtimeSession({ apiKey: 'key', voice: 'voice', boundary: boundary(), signal: controller.signal }, options)
    controller.abort()
    socket.event({ type: 'session.created', session: { id: 'late' } }); socket.event({ type: 'session.closed' })
    await expect(promise).rejects.toMatchObject({ code: 'REALTIME_CHECK_CANCELLED' })
    expect(socket.sent).toEqual([])
  })
  it('sanitizes HTTP auth failures and server errors, closes the socket on timeout', async () => {
    const auth = fixture()
    const promise = checkNativeRealtimeSession({ apiKey: 'key', voice: 'voice', boundary: boundary() }, auth.options)
    auth.socket.emit('unexpected-response', {}, { statusCode: 403, resume: vi.fn() })
    await expect(promise).rejects.toMatchObject({ code: 'REALTIME_AUTH_FAILED' })
    const timed = fixture(5)
    await expect(checkNativeRealtimeSession({ apiKey: 'key', voice: 'voice', boundary: boundary() }, timed.options))
      .rejects.toMatchObject({ code: 'REALTIME_CHECK_TIMEOUT' })
    expect(timed.socket.terminate).toHaveBeenCalledOnce()
    const failed = fixture()
    const rejection = checkNativeRealtimeSession({ apiKey: 'key', voice: 'voice', boundary: boundary() }, failed.options)
    failed.socket.event({ type: 'error', error: { code: 'unknown', message: 'private-secret' } })
    await expect(rejection).rejects.toThrow('REALTIME_SERVER_REJECTED')
  })
  it('rejects missing configuration, binary frames and exposed tools in the diagnostic', async () => {
    expect(() => nativeSessionCreate(boundary(), '')).toThrow('REALTIME_VOICE_REQUIRED')
    await expect(checkNativeRealtimeSession({ apiKey: '', voice: 'voice', boundary: boundary() }))
      .rejects.toMatchObject({ code: 'REALTIME_NOT_CONFIGURED' })
    const { socket, options } = fixture()
    const promise = checkNativeRealtimeSession({ apiKey: 'key', voice: 'voice', boundary: boundary() }, options)
    socket.emit('message', Buffer.from('binary'), true)
    await expect(promise).rejects.toMatchObject({ code: 'REALTIME_PROTOCOL_INVALID' })
  })
  it.each([['401', 'REALTIME_AUTH_FAILED'], [403, 'REALTIME_AUTH_FAILED'], ['45000001', 'REALTIME_AUTH_FAILED'],
    [429, 'REALTIME_QUOTA_LIMIT'], ['unrecognized', 'REALTIME_SERVER_REJECTED']])('sanitizes server event code %s', async (code, category) => {
    const { socket, options } = fixture()
    const promise = checkNativeRealtimeSession({ apiKey: 'key', voice: 'voice', boundary: boundary() }, options)
    socket.event({ type: 'error', error: { code, message: 'key=private-secret' } })
    await expect(promise).rejects.toMatchObject({ code: category, message: category })
    expect(socket.terminate).toHaveBeenCalledOnce()
  })
})
