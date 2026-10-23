import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { synthesizeNativeAnnouncement } from '../electron/main/providers/nativeAnnouncement'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { R1ModelRequestBoundary } from '../electron/main/r1/modelBoundary'
import { modelContext } from './helpers/r1ModelFixtures'
const assets = loadR1PromptAssets(resolve('r1-assets'))
const boundary = () => new R1ModelRequestBoundary(assets, { assistantName: 'Seamo AI', userAddress: '', style: '', voiceId: '', version: 1 }, modelContext(), [], 'realtime', () => undefined, true)
afterEach(() => vi.unstubAllEnvs())
it('collects one utterance into a valid mono PCM24k WAV without tools, microphone or user messages', async () => {
  vi.stubEnv('VOLCENGINE_REALTIME_API_KEY', 'synthetic')
  const sent: any[] = []
  const connect = () => {
    const socket = Object.assign(new EventEmitter(), { bufferedAmount: 0, terminate: vi.fn(), send(raw: string) {
      const event = JSON.parse(raw); sent.push(event)
      if (event.type === 'session.create') queueMicrotask(() => socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.created', session: { id: 'fixture' } })), false))
      if (event.type === 'speech_text_buffer.commit') queueMicrotask(() => {
        for (const item of [{ type: 'response.output_audio.delta', response_id: 'fixture', delta: 'AQACAA==' }, { type: 'response.output_audio.done', response_id: 'fixture' }]) socket.emit('message', Buffer.from(JSON.stringify(item)), false)
      })
    } })
    queueMicrotask(() => socket.emit('open')); return socket as unknown as WebSocket
  }
  const wav = Buffer.from(await synthesizeNativeAnnouncement({ text: '已整理完成。', voice: 'voice', boundary: boundary(), signal: new AbortController().signal }, connect))
  expect(wav.length).toBe(48); expect(wav.subarray(0, 4).toString()).toBe('RIFF'); expect(wav.readUInt32LE(24)).toBe(24000)
  expect(wav.readUInt16LE(22)).toBe(1); expect(wav.readUInt32LE(40)).toBe(4)
  expect(sent.some(e => ['conversation.item.create', 'input_audio_buffer.append'].includes(e.type))).toBe(false)
  expect(sent.find(e => e.type === 'session.create').session.tools).toEqual([])
  expect(sent.find(e => e.type === 'speech_text_buffer.commit').text).toBe('已整理完成。')
})
it('does not open a connection when already cancelled', async () => {
  const controller = new AbortController(); controller.abort(); const connect = vi.fn()
  await expect(synthesizeNativeAnnouncement({ text: '取消', voice: 'voice', boundary: boundary(), signal: controller.signal }, connect)).rejects.toThrow('ANNOUNCEMENT_CANCELLED')
  expect(connect).not.toHaveBeenCalled()
})
it.each([20, 46])('bounds a %s-second utterance without dropping a normal completion brief at 15 seconds', async seconds => {
  vi.stubEnv('VOLCENGINE_REALTIME_API_KEY', 'synthetic')
  const connect = () => {
    const socket = Object.assign(new EventEmitter(), { bufferedAmount: 0, terminate: vi.fn(), send(raw: string) {
      const event = JSON.parse(raw)
      if (event.type === 'session.create') queueMicrotask(() => socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.created', session: { id: 'long-fixture' } })), false))
      if (event.type === 'speech_text_buffer.commit') queueMicrotask(() => {
        const delta = Buffer.alloc(48000).toString('base64')
        for (let i = 0; i < seconds; i++) socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'long-fixture', delta })), false)
        socket.emit('message', Buffer.from(JSON.stringify({ type: 'response.output_audio.done', response_id: 'long-fixture' })), false)
      })
    } })
    queueMicrotask(() => socket.emit('open')); return socket as unknown as WebSocket
  }
  const result = synthesizeNativeAnnouncement({ text: '已完成工作稿。', voice: 'voice', boundary: boundary(), signal: new AbortController().signal }, connect)
  if (seconds === 20) expect((await result).byteLength).toBe(960044)
  else await expect(result).rejects.toThrow('ANNOUNCEMENT_AUDIO_LIMIT')
})
