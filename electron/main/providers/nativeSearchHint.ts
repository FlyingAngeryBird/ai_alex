import { NativeRealtimeSession } from './nativeRealtimeSession.js'
import type { R1ModelRequestBoundary } from '../r1/modelBoundary.js'

/** One short TTS-only clip per voice/configuration, memory only. Never inject
 * a greeting event into an M01 connection waiting for function-call results. */
export function createNativeSearchHintCache(options: {
  connect?: ConstructorParameters<typeof NativeRealtimeSession>[0]['connect']
} = {}) {
  const cache = new Map<string, Promise<Buffer | null>>()
  return (input: { voice: string; configurationRevision: number; boundary: R1ModelRequestBoundary; signal: AbortSignal }): Promise<Buffer | null> => {
    if (input.boundary.diagnostic.toolAliases.length) throw new Error('REALTIME_HINT_TOOLS_FORBIDDEN')
    const key = `${input.configurationRevision}:${input.voice}`
    const prior = cache.get(key)
    if (prior) return prior
    if (cache.size >= 2) cache.clear()
    const promise = new Promise<Buffer | null>(resolve => {
      let settled = false, bytes = 0
      const chunks: Buffer[] = []
      let session: NativeRealtimeSession | null = null
      const finish = (success = false) => {
        if (settled) return
        settled = true; clearTimeout(timeout); input.signal.removeEventListener('abort', cancelled)
        session?.close()
        const buffer = success && bytes ? Buffer.concat(chunks) : null
        resolve(buffer)
      }
      const cancelled = () => finish()
      const timeout = setTimeout(() => finish(), 5000)
      input.signal.addEventListener('abort', cancelled, { once: true })
      if (input.signal.aborted) { finish(); return }
      session = new NativeRealtimeSession({ apiKey: process.env.VOLCENGINE_REALTIME_API_KEY ?? '', voice: input.voice,
        boundary: input.boundary, connect: options.connect, onToolCalls() { finish() }, onClosed() { finish() },
        onEvent(event) {
          if (event.type === 'response.output_audio.delta' && typeof event.delta === 'string') {
            const chunk = Buffer.from(event.delta, 'base64')
            if (!chunk.length || chunk.length % 2 || bytes + chunk.length > 96000) { finish(); return }
            chunks.push(chunk); bytes += chunk.length
          }
          if (event.type === 'response.output_audio.done') finish(true)
        } })
      void session.open().then(() => { if (!settled) session!.speakSearchHint() }).catch(() => finish())
    })
    cache.set(key, promise)
    void promise.then(buffer => { if (!buffer && cache.get(key) === promise) cache.delete(key) })
    return promise
  }
}
