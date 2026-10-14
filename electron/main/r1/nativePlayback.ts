import type { NativeRealtimeEvent } from '../providers/nativeRealtimeSession.js'
import type { R1Conversations } from './conversations.js'

type Response = { turnId: string; text: string; textDone: boolean; saved: boolean;
  sentMs: number; audioDone: boolean; playedMs: number;
  status: 'playing' | 'completed' | 'interrupted' }
/** Generated text and rendered PCM have separate receipts; duration never estimates a text prefix. */
export class NativePlaybackLedger {
  private responses = new Map<string, Response>()
  constructor(private readonly conversations: R1Conversations, private readonly sessionId: string) {}
  receive(event: NativeRealtimeEvent, turnId: string): void {
    if (typeof event.response_id !== 'string' || !event.response_id || !event.type.startsWith('response.output_')) return
    const id = event.response_id
    const response = this.responses.get(id) ?? { turnId, text: '', textDone: false, saved: false,
      sentMs: 0, audioDone: false, playedMs: 0, status: 'playing' }
    if (response.status === 'interrupted') return
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string' && !response.textDone) response.text += event.delta
    if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
      response.text = event.text; response.textDone = true
    }
    if ([...response.text].length > 8000) throw new Error('REALTIME_TEXT_LIMIT_EXCEEDED')
    if (event.type === 'response.output_audio.delta' && typeof event.delta === 'string') {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.delta)) throw new Error('REALTIME_AUDIO_INVALID')
      const bytes = Buffer.from(event.delta, 'base64').byteLength
      if (!bytes || bytes % 2) throw new Error('REALTIME_AUDIO_INVALID')
      response.sentMs += bytes / 48
    }
    if (event.type === 'response.output_audio.done') response.audioDone = true
    this.responses.set(id, response)
    if (response.textDone) this.persist(id, response)
  }
  private persist(id: string, response: Response): void {
    if (!response.saved && response.text.trim()) {
      this.conversations.append({ sessionId: this.sessionId, turnId: response.turnId, responseId: id,
        role: 'assistant', body: response.text, status: 'generated' })
      response.saved = true
    }
    if (response.saved && (response.playedMs > 0 || response.status !== 'playing')) {
      this.conversations.recordPlayback({ sessionId: this.sessionId, responseId: id,
        playedUntilMs: response.playedMs, status: response.status })
    }
  }
  playback(input: Record<string, unknown>): void {
    const id = String(input.responseId), response = this.responses.get(id), ms = input.playedUntilMs
    if (!response || !Number.isSafeInteger(ms) || (ms as number) < 0 ||
      (ms as number) > Math.ceil(response.sentMs) ||
      !['started', 'playing', 'underrun', 'completed', 'interrupted'].includes(String(input.status))) throw new Error('INVALID_PLAYBACK_RECEIPT')
    if (response.status === 'completed' || response.status === 'interrupted' || (ms as number) < response.playedMs) return
    if (input.status === 'completed' && (!response.audioDone || Math.abs(response.sentMs - (ms as number)) > 1)) throw new Error('INVALID_PLAYBACK_COMPLETION')
    response.playedMs = ms as number
    response.status = input.status === 'completed' ? 'completed' : input.status === 'interrupted' ? 'interrupted' : 'playing'
    if (response.status === 'interrupted' || response.textDone) this.persist(id, response)
  }
  interruptPending(): void {
    for (const [id, response] of this.responses) {
      if (response.status === 'completed' || response.status === 'interrupted') continue
      response.status = 'interrupted'; this.persist(id, response)
    }
  }
}
