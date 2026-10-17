import { describe, expect, it } from 'vitest'
import { createPcmRingBuffer } from '../src/services/pcmRingBuffer'

describe('pcm ring buffer', () => {
  it('keeps only the most recent pcm samples', () => {
    const buffer = createPcmRingBuffer({ maxSamples: 5 })

    buffer.append(new Int16Array([1, 2, 3]))
    buffer.append(new Int16Array([4, 5, 6, 7]))

    expect([...new Int16Array(buffer.toArrayBuffer())]).toEqual([3, 4, 5, 6, 7])
  })

  it('clears buffered audio after it is consumed', () => {
    const buffer = createPcmRingBuffer({ maxSamples: 5 })

    buffer.append(new Int16Array([1, 2, 3]))
    expect([...new Int16Array(buffer.consumeArrayBuffer())]).toEqual([1, 2, 3])
    expect(new Int16Array(buffer.consumeArrayBuffer())).toHaveLength(0)
  })
})
