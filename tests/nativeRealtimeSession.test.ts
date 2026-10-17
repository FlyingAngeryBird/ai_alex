import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { NativeRealtimeSession } from '../electron/main/providers/nativeRealtimeSession'
import { R1ModelRequestBoundary } from '../electron/main/r1/modelBoundary'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { modelContext } from './helpers/r1ModelFixtures'
class Socket extends EventEmitter {
  bufferedAmount = 0
  sent: Record<string, unknown>[] = []
  terminate = vi.fn()
  send(value: string) { this.sent.push(JSON.parse(value)) }
  event(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value)), false) }
}
function fixture() {
  const socket = new Socket(), onEvent = vi.fn(), onClosed = vi.fn(), onToolCalls = vi.fn()
  const boundary = new R1ModelRequestBoundary(loadR1PromptAssets(resolve('r1-assets')),
    { assistantName: 'Seamo AI', userAddress: '', style: '简洁', voiceId: '', version: 1 },
    modelContext({ temporary: true }), [], 'realtime')
  const session = new NativeRealtimeSession({ apiKey: 'synthetic', voice: 'test_voice', boundary,
    onEvent, onClosed, onToolCalls, connect: () => socket as unknown as WebSocket })
  return { socket, session, onEvent, onClosed, onToolCalls }
}
it.each([['401', 'REALTIME_AUTH_FAILED'], [403, 'REALTIME_AUTH_FAILED'], ['45000002', 'REALTIME_AUTH_FAILED'],
  [429, 'REALTIME_QUOTA_LIMIT'], ['unknown', 'REALTIME_SERVER_REJECTED']])('uses the same safe event failure category for %s before and after session creation', async (code, category) => {
  for (const ready of [false, true]) {
    const { session, socket, onEvent, onClosed } = fixture()
    const opened = session.open()
    // Attach the rejection handler before delivering a synchronous fixture event.
    const result = opened.then(() => 'ready', error => error.code)
    socket.emit('open')
    if (ready) { socket.event({ type: 'session.created', session: { id: 'test' } }); await result }
    onEvent.mockClear()
    socket.event({ type: 'error', error: { code, message: 'key=private-secret' } })
    if (!ready) expect(await result).toBe(category)
    expect(onClosed).toHaveBeenCalledWith(category)
    expect(onClosed).toHaveBeenCalledOnce(); expect(socket.terminate).toHaveBeenCalledOnce()
    expect(onEvent).not.toHaveBeenCalled()
    expect(() => session.appendAudio(new Uint8Array([0, 0]))).toThrow('REALTIME_NOT_READY')
  }
})
it('waits for session acknowledgement, streams PCM, and drops canceled response audio', async () => {
  const { session, socket, onEvent, onClosed } = fixture()
  const opened = session.open()
  socket.emit('open')
  expect(() => session.appendAudio(new Uint8Array([0, 0]))).toThrow('REALTIME_NOT_READY')
  socket.event({ type: 'session.created', session: { id: 'session' } }); await opened
  session.setMuted(false); session.appendAudio(new Uint8Array([1, 0, 2, 0]))
  expect(socket.sent.at(-1)).toMatchObject({ type: 'input_audio_buffer.append', audio: 'AQACAA==' })
  socket.event({ type: 'response.output_audio.delta', response_id: 'old', delta: 'AQACAA==' })
  expect(session.cancelResponse()).toBe('old')
  onEvent.mockClear()
  socket.event({ type: 'response.output_audio.delta', response_id: 'old', delta: 'AQACAA==' })
  socket.event({ type: 'response.output_audio.delta', response_id: 'next', delta: 'AQACAA==' })
  expect(onEvent).toHaveBeenCalledTimes(1)
  expect(onEvent.mock.calls[0][0].response_id).toBe('next')
  session.close(); session.close()
  expect(onClosed).toHaveBeenCalledTimes(1)
  expect(socket.terminate).toHaveBeenCalledTimes(1)
})
it('fails closed on unauthorized tool calls and rejects late events after shutdown', async () => {
  const { session, socket, onEvent, onClosed, onToolCalls } = fixture()
  const opened = session.open(); socket.emit('open')
  socket.event({ type: 'session.created', session: { id: 'session' } }); await opened
  onEvent.mockClear()
  socket.event({ type: 'response.function_call_arguments.done', items: [
    { call_id: 'bad', name: 'unauthorized_write', arguments: '{}' }
  ] })
  socket.event({ type: 'response.output_text.delta', response_id: 'late', delta: 'late' })
  expect(onToolCalls).not.toHaveBeenCalled()
  expect(onEvent).not.toHaveBeenCalled()
  expect(onClosed).toHaveBeenCalledWith('REALTIME_PROTOCOL_OR_CONTEXT_INVALID')
})

it('pairs audio without a response ID through its explicit question and completes ASR from the same item deltas', async () => {
  const { session, socket, onEvent } = fixture()
  const opened = session.open(); socket.emit('open')
  socket.event({ type: 'session.created', session: { id: 'session' } }); await opened
  socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'q1', delta: '合成' })
  socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'q2', delta: '另一条' })
  socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'q1', delta: '合成测试' })
  socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'q1' })
  expect(onEvent.mock.calls.at(-1)?.[0]).toMatchObject({ item_id: 'q1', transcript: '合成测试' })
  socket.event({ type: 'response.output_text.done', question_id: 'q1', response_id: 'r1', text: 'fixture' })
  socket.event({ type: 'response.output_audio.delta', question_id: 'q1', delta: 'AQACAA==' })
  expect(onEvent.mock.calls.at(-1)?.[0]).toMatchObject({ response_id: 'r1', delta: 'AQACAA==' })
  socket.event({ type: 'response.output_audio.done', question_id: 'q1', response_id: '' })
  expect(onEvent.mock.calls.at(-1)?.[0]).toMatchObject({ response_id: 'r1' })
  expect(session.cancelResponse()).toBe('r1')
  onEvent.mockClear()
  socket.event({ type: 'response.output_audio.delta', question_id: 'q1', delta: 'AQACAA==' })
  expect(onEvent).not.toHaveBeenCalled()
  socket.event({ type: 'response.output_audio.delta', question_id: 'q2', delta: 'AQACAA==' })
  expect(onEvent.mock.calls.at(-1)?.[0]).toMatchObject({ response_id: 'question:q2' })
  session.close()
})

it('binds actual identifier-free PCM deltas only inside the matching started/done audio interval', async () => {
  const { session, socket, onEvent } = fixture()
  const opened = session.open(); socket.emit('open')
  socket.event({ type: 'session.created', session: { id: 'session' } }); await opened
  socket.event({ type: 'response.output_audio.started', question_id: 'q', response_id: 'r' })
  socket.event({ type: 'response.output_audio.delta', event_id: 'a1', delta: 'AQACAA==' })
  expect(onEvent.mock.calls.at(-1)?.[0]).toMatchObject({ response_id: 'r' })
  expect(session.cancelResponse()).toBe('r')
  onEvent.mockClear()
  socket.event({ type: 'response.output_audio.delta', event_id: 'a2', delta: 'AQACAA==' })
  expect(onEvent).not.toHaveBeenCalled()
  socket.event({ type: 'response.output_audio.done', question_id: 'q', response_id: 'r' })
  socket.event({ type: 'response.output_audio.started', question_id: 'next', response_id: 'r2' })
  socket.event({ type: 'response.output_audio.delta', event_id: 'a3', delta: 'AQACAA==' })
  expect(onEvent.mock.calls.at(-1)?.[0]).toMatchObject({ response_id: 'r2' })
  socket.event({ type: 'response.output_audio.done', question_id: 'next', response_id: 'r2' })
  socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i', delta: '你' })
  socket.event({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i', delta: '你你' })
  socket.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i', text: '你好。' })
  expect(onEvent.mock.calls.at(-1)?.[0]).toMatchObject({ transcript: '你好。' })
  session.close()
})
