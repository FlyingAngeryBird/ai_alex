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
