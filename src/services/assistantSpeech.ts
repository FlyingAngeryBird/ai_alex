export type SpeechPurpose = 'reply' | 'preview' | 'proactive'
export type TtsResult = { ok: true; data: { audio: ArrayBuffer; mimeType: string } } | { ok: false; error: { code: string; message: string } }
export type SpeechPlayback = { status: 'started' | 'playing' | 'completed' | 'interrupted'; playedUntilMs: number }
/** Owns fallback speech output; policy changes and stale promises cannot revive it. */
export function createAssistantSpeech(options: {
  request(text: string, voice?: string): Promise<TtsResult>
  canSpeakProactively(): boolean
  configureOutput?: (audio: HTMLAudioElement) => Promise<() => void>
  onSpeaking(active: boolean): void
  onEnded(): void
  onPurposeChange?(purpose: SpeechPurpose | null): void
  mark?(point: string): void
  createAudio?: (url: string) => HTMLAudioElement
  objectUrl?: (blob: Blob) => string
  revokeUrl?: (url: string) => void
}) {
  let generation = 0, audio: HTMLAudioElement | null = null, url: string | null = null
  let releaseOutput: (() => void) | null = null, purpose: SpeechPurpose | null = null
  let playback: ((receipt: SpeechPlayback) => void) | null = null, playedUntilMs = 0
  function report(status: SpeechPlayback['status']): void {
    const seconds = audio?.currentTime
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) playedUntilMs = Math.max(playedUntilMs, Math.floor(seconds * 1000))
    const listener = playback
    if (status === 'completed' || status === 'interrupted') playback = null
    try { listener?.({ status, playedUntilMs }) } catch { /* Reporting must not prevent device cleanup. */ }
  }
  const allowed = (reason: SpeechPurpose) => reason !== 'proactive' || options.canSpeakProactively()
  function stop(resume = false): void {
    report('interrupted')
    generation++; purpose = null; options.onPurposeChange?.(null); options.onSpeaking(false)
    audio?.pause(); audio = null
    releaseOutput?.(); releaseOutput = null
    if (url) (options.revokeUrl ?? URL.revokeObjectURL)(url)
    url = null
    if (resume) options.onEnded()
  }
  function policyChanged(): void { if (purpose === 'proactive' && !allowed(purpose)) stop(true) }
  async function speak(text: string, voice?: string, reason: SpeechPurpose = 'reply', prepared?: TtsResult,
    onPlayback?: (receipt: SpeechPlayback) => void): Promise<void> {
    if (!text.trim() || !allowed(reason)) return
    stop(); playedUntilMs = 0; playback = onPlayback ?? null
    purpose = reason; options.onPurposeChange?.(reason); const epoch = generation
    const current = () => epoch === generation && allowed(reason)
    try {
      options.mark?.('tts_first_push')
      const result = prepared ?? await options.request(text.trim(), voice)
      if (!current()) return
      if (!result.ok) { stop(true); return }
      options.mark?.('tts_first_audio')
      url = (options.objectUrl ?? URL.createObjectURL)(new Blob([result.data.audio], { type: result.data.mimeType }))
      const target = (options.createAudio ?? (value => new Audio(value)))(url)
      audio = target
      target.addEventListener('playing', () => { if (current()) { report('started'); options.onSpeaking(true); options.mark?.('tts_play_start') } else target.pause() }, { once: true })
      target.addEventListener('timeupdate', () => { if (current()) report('playing') })
      target.addEventListener('ended', () => { if (epoch === generation) { report('completed'); options.mark?.('tts_play_end'); stop(true) } }, { once: true })
      target.addEventListener('error', () => { if (epoch === generation) stop(true) }, { once: true })
      if (options.configureOutput) {
        const release = await options.configureOutput(target)
        if (!current()) { release(); target.pause(); return }
        releaseOutput = release
      }
      if (!current()) { target.pause(); return }
      options.mark?.('tts_play_invoked')
      await target.play()
      if (!current()) target.pause()
    } catch { if (epoch === generation) stop(true) }
  }
  return { speak, stop, policyChanged }
}
