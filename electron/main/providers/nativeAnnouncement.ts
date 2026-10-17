import { NativeRealtimeSession } from './nativeRealtimeSession.js'
import type { R1ModelRequestBoundary } from '../r1/modelBoundary.js'

/** Bounded, single utterance using native TTS without microphone or model tools. */
export async function synthesizeNativeAnnouncement(input: {
  text: string; voice: string; boundary: R1ModelRequestBoundary; signal: AbortSignal
}, connect?: ConstructorParameters<typeof NativeRealtimeSession>[0]['connect']): Promise<ArrayBuffer> {
  if (input.boundary.diagnostic.toolAliases.length) throw new Error('ANNOUNCEMENT_TOOLS_FORBIDDEN')
  const pcm = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, settled = false
    let session: NativeRealtimeSession | null = null
    const finish = (success: boolean, code = 'ANNOUNCEMENT_CANCELLED_OR_UNAVAILABLE') => {
      if (settled) return
      settled = true; clearTimeout(timer); input.signal.removeEventListener('abort', abort); session?.close()
      if (success && size) resolve(Buffer.concat(chunks)); else reject(new Error(code))
    }
    const abort = () => finish(false), timer = setTimeout(abort, 12000)
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) { abort(); return }
    session = new NativeRealtimeSession({ apiKey: process.env.VOLCENGINE_REALTIME_API_KEY ?? '', voice: input.voice,
      boundary: input.boundary, connect, onToolCalls: abort, onClosed: code => finish(false, code), onEvent(event) {
        if (event.type === 'response.output_audio.delta' && typeof event.delta === 'string') {
          const bytes = Buffer.from(event.delta, 'base64')
          if (!bytes.length || bytes.length % 2 || size + bytes.length > 720000) { abort(); return }
          size += bytes.length; chunks.push(bytes)
        }
        if (event.type === 'response.output_audio.done') finish(true)
      } })
    void session.open().then(() => { if (!settled) session!.speakText(input.text) }).catch(abort)
  })
  input.boundary.assertCurrent()
  const wave = Buffer.alloc(44 + pcm.length)
  wave.write('RIFF'); wave.writeUInt32LE(36 + pcm.length, 4); wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22)
  wave.writeUInt32LE(24000, 24); wave.writeUInt32LE(48000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34)
  wave.write('data', 36); wave.writeUInt32LE(pcm.length, 40); pcm.copy(wave, 44)
  return wave.buffer.slice(wave.byteOffset, wave.byteOffset + wave.byteLength) as ArrayBuffer
}
