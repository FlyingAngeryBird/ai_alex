import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { createNativeSearchHintCache } from '../electron/main/providers/nativeSearchHint'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { R1ModelRequestBoundary } from '../electron/main/r1/modelBoundary'
import { modelContext } from './helpers/r1ModelFixtures'
const assets = loadR1PromptAssets(resolve('r1-assets'))
const boundary = (tools: string[] = []) => new R1ModelRequestBoundary(assets, { assistantName: 'Seamo AI', userAddress: '', style: '', voiceId: '', version: 1 }, modelContext(), tools, 'realtime')
afterEach(() => vi.unstubAllEnvs())
it('renders one TTS-only clip per voice/configuration in a separate connection and caches it in memory', async () => {
 vi.stubEnv('VOLCENGINE_REALTIME_API_KEY', 'synthetic')
 const sent: Record<string, unknown>[] = []
 const connect = vi.fn(() => {
  const socket = Object.assign(new EventEmitter(), { bufferedAmount: 0, terminate: vi.fn(), send(text: string) {
   const e = JSON.parse(text); sent.push(e)
   if (e.type === 'session.create') queueMicrotask(() => socket.emit('message', Buffer.from(JSON.stringify({ type: 'session.created', session: { id: 'hint' } })), false))
   if (e.type === 'speech_text_buffer.commit') queueMicrotask(() => {
    for (const event of [{ type: 'response.output_audio.delta', response_id: 'hint', delta: 'AQACAA==' }, { type: 'response.output_audio.done', response_id: 'hint' }]) socket.emit('message', Buffer.from(JSON.stringify(event)), false)
   })
  } })
  queueMicrotask(() => socket.emit('open')); return socket as unknown as WebSocket
 })
 const cache = createNativeSearchHintCache({ connect }), input = { voice: 'voice', configurationRevision: 1, boundary: boundary(), signal: new AbortController().signal }
 const first = cache(input), second = cache(input)
 expect(first).toBe(second); expect(await first).toEqual(Buffer.from([1, 0, 2, 0]))
 expect(await cache(input)).toEqual(Buffer.from([1, 0, 2, 0])); expect(connect).toHaveBeenCalledTimes(1)
 expect(sent.filter(e => e.type === 'speech_text_buffer.commit')).toHaveLength(1)
 expect(sent.some(e => ['input_audio_buffer.append', 'conversation.item.create'].includes(String(e.type)))).toBe(false)
 expect((sent.find(e => e.type === 'session.create')!.session as { tools: unknown[] }).tools).toEqual([])
})
it('rejects model tools and avoids opening a connection for a cancelled warmup', async () => {
 const connect = vi.fn(), cache = createNativeSearchHintCache({ connect }), controller = new AbortController()
 controller.abort()
 expect(await cache({ voice: 'voice', configurationRevision: 1, boundary: boundary(), signal: controller.signal })).toBeNull()
 expect(connect).not.toHaveBeenCalled()
 expect(() => cache({ voice: 'voice', configurationRevision: 2, boundary: boundary(['load_skill']), signal: controller.signal })).toThrow('REALTIME_HINT_TOOLS_FORBIDDEN')
})
