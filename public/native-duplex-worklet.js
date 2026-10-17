/* One audio clock owns continuous playback and microphone framing. No network or storage here. */
class NativeDuplexProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ring = new Float32Array(24000 * 30)
    this.read = 0; this.write = 0; this.responseId = null; this.playing = false; this.finished = false
    this.cancelled = new Set(); this.capture = false; this.inputWeight = 0; this.inputSum = 0
    this.pcm = new Int16Array(320); this.pcmIndex = 0; this.reportAt = 0; this.started = false
    this.port.onmessage = ({ data }) => {
      if (data.type === 'capture') {
        this.capture = data.enabled
        if (!this.capture) { this.pcmIndex = 0; this.inputSum = 0; this.inputWeight = 0 }
        return
      }
      if (data.type === 'clear') {
        if (this.responseId) { this.report('interrupted'); this.cancelled.add(this.responseId) }
        this.reset(null); this.port.postMessage({ type: 'cleared', requestId: data.requestId }); return
      }
      if (data.type === 'audio' || data.type === 'done') {
        if (typeof data.responseId !== 'string' || this.cancelled.has(data.responseId)) return
        if (this.responseId !== data.responseId) {
          if (this.responseId && this.read < this.write) { this.report('interrupted'); this.cancelled.add(this.responseId) }
          this.reset(data.responseId)
        }
        if (data.type === 'done') {
          this.finished = true
          if (this.started && this.read >= this.write) { this.report('completed'); this.cancelled.add(this.responseId); this.reset(null) }
          return
        }
        const bytes = data.pcm
        if (!(bytes instanceof Uint8Array) || bytes.length % 2) return
        const length = bytes.length / 2
        if (this.write - Math.floor(this.read) + length > this.ring.length) {
          this.report('interrupted'); this.cancelled.add(this.responseId); this.reset(null)
          this.port.postMessage({ type: 'error', code: 'PLAYBACK_OVERFLOW' }); return
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        for (let i = 0; i < length; i++) this.ring[this.write++ % this.ring.length] = view.getInt16(i * 2, true) / 32768
      }
    }
  }
  reset(id) {
    this.responseId = id; this.read = 0; this.write = 0; this.playing = false
    this.finished = false; this.started = false; this.reportAt = 0
  }
  report(status) {
    if (this.responseId) this.port.postMessage({ type: 'playback', responseId: this.responseId,
      playedUntilMs: Math.floor(Math.min(this.read, this.write) / 24), status })
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0], output = outputs[0]?.[0]
    if (this.capture && input) {
      const ratio = sampleRate / 16000
      for (const sample of input) {
        let remaining = 1
        while (remaining > 0.000001) {
          const weight = Math.min(remaining, ratio - this.inputWeight)
          this.inputSum += sample * weight; this.inputWeight += weight; remaining -= weight
          if (this.inputWeight >= ratio - 0.000001) {
            const value = Math.max(-1, Math.min(1, this.inputSum / ratio))
            this.pcm[this.pcmIndex++] = Math.round(value * (value < 0 ? 32768 : 32767))
            this.inputSum = 0; this.inputWeight = 0
            if (this.pcmIndex === this.pcm.length) {
              const bytes = new Uint8Array(this.pcm.length * 2), view = new DataView(bytes.buffer)
              for (let i = 0; i < this.pcm.length; i++) view.setInt16(i * 2, this.pcm[i], true)
              this.port.postMessage({ type: 'capture', pcm: bytes }, [bytes.buffer]); this.pcmIndex = 0
            }
          }
        }
      }
    }
    if (!output || !this.responseId) return true
    // 150 ms candidate starting buffer, shortened only when the provider has finished a short utterance.
    if (!this.playing && (this.write - this.read >= 3600 || this.finished && this.write > this.read)) {
      this.playing = true; this.started = true; this.report('started')
    }
    if (!this.playing) return true
    for (let i = 0; i < output.length; i++) {
      if (this.read >= this.write) break
      const left = Math.floor(this.read), fraction = this.read - left
      output[i] = this.ring[left % this.ring.length] * (1 - fraction) +
        this.ring[Math.min(left + 1, this.write - 1) % this.ring.length] * fraction
      this.read = Math.min(this.write, this.read + 24000 / sampleRate)
    }
    if (this.read >= this.write) {
      if (this.finished) { this.report('completed'); this.cancelled.add(this.responseId); this.reset(null) }
      else { this.report('underrun'); this.playing = false }
    } else if (this.read - this.reportAt >= 2400) { this.reportAt = this.read; this.report('playing') }
    return true
  }
}
registerProcessor('seamo-native-duplex', NativeDuplexProcessor)
