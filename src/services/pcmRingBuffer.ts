export type PcmRingBufferOptions = {
  maxSamples: number
}

export function createPcmRingBuffer(options: PcmRingBufferOptions) {
  const maxSamples = Math.max(0, Math.floor(options.maxSamples))
  let samples = new Int16Array(0)

  function append(nextSamples: Int16Array): void {
    if (maxSamples === 0 || nextSamples.length === 0) {
      return
    }

    const merged = new Int16Array(samples.length + nextSamples.length)

    merged.set(samples, 0)
    merged.set(nextSamples, samples.length)
    samples = merged.length > maxSamples ? merged.slice(merged.length - maxSamples) : merged
  }

  function toArrayBuffer(): ArrayBuffer {
    return Uint8Array.from(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)).buffer
  }

  function clear(): void {
    samples = new Int16Array(0)
  }

  function consumeArrayBuffer(): ArrayBuffer {
    const audio = toArrayBuffer()

    clear()
    return audio
  }

  return {
    append,
    clear,
    consumeArrayBuffer,
    toArrayBuffer
  }
}
