/** Speech attenuation is separate from the user's chosen base volume and playback state. */
export class MusicDucking {
  private audio: Pick<HTMLAudioElement, 'volume'> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private base = 1
  private factor = 1
  private speaking = false
  attach(audio: Pick<HTMLAudioElement, 'volume'> | null): void {
    this.audio = audio
    this.apply()
  }
  setVolume(value: number): void {
    if (!Number.isFinite(value)) return
    this.base = Math.max(0, Math.min(1, value))
    this.apply()
  }
  setSpeechActive(active: boolean): void {
    if (this.speaking === active) return
    this.speaking = active
    if (this.timer) clearInterval(this.timer)
    const from = this.factor, to = active ? 0.2 : 1, duration = active ? 100 : 300
    const start = performance.now()
    this.timer = setInterval(() => {
      const progress = Math.min(1, (performance.now() - start) / duration)
      this.factor = from + (to - from) * progress
      this.apply()
      if (progress === 1 && this.timer) { clearInterval(this.timer); this.timer = null }
    }, 16)
  }
  private apply(): void { if (this.audio) this.audio.volume = this.base * this.factor }
  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null; this.audio = null
  }
}
