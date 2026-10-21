import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'

/** Sample-clock simulation only: no microphone, real network or speaker hearing. */
function clock(rate = 24000) {
  const events: Array<Record<string, any>> = []
  let Processor: any
  runInNewContext(readFileSync('public/native-duplex-worklet.js', 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage: (event: Record<string, unknown>) => events.push(event), onmessage: null } },
    sampleRate: rate, Uint8Array, DataView, registerProcessor: (_name: string, value: unknown) => { Processor = value }
  })
  const node = new Processor()
  const send = (data: Record<string, unknown>) => node.port.onmessage({ data })
  const output = new Float32Array(128)
  const render = () => { output.fill(0); node.process([], [[output]]); return output }
  const pcm = (samples: number) => {
    const bytes = new Uint8Array(samples * 2), view = new DataView(bytes.buffer)
    for (let index = 0; index < samples; index++) view.setInt16(index * 2, 8192, true)
    return bytes
  }
  return { events, node, send, render, pcm }
}
it('distinguishes a delayed sentence-end event from a real buffer refill and never replays a cancelled segment', () => {
  const s = clock()
  s.send({ type: 'audio', responseId: 'tail', pcm: s.pcm(3840) })
  for (let i = 0; i < 30; i++) s.render()
  expect(s.events.filter(event => event.status === 'underrun')).toHaveLength(1)
  s.send({ type: 'done', responseId: 'tail' })
  expect(s.events.filter(event => event.status === 'completed')).toHaveLength(1)
  expect(s.events.filter(event => event.resumedAfterUnderrun === true)).toHaveLength(0)
  s.send({ type: 'audio', responseId: 'refill', pcm: s.pcm(3840) })
  for (let i = 0; i < 30; i++) s.render()
  for (let i = 0; i < 10; i++) expect([...s.render()].every(sample => sample === 0)).toBe(true)
  s.send({ type: 'audio', responseId: 'refill', pcm: s.pcm(3840) })
  expect(s.render()[0]).toBe(0.25)
  expect(s.events.filter(event => event.resumedAfterUnderrun === true)).toHaveLength(1)
  s.send({ type: 'clear', requestId: 'interrupt' })
  s.send({ type: 'audio', responseId: 'refill', pcm: s.pcm(3840) })
  expect([...s.render()].every(sample => sample === 0)).toBe(true)
})
it('plays 20 independent synthetic turns, interrupts alternate replies, and rejects their late PCM', () => {
  const s = clock()
  for (let turn = 0; turn < 20; turn++) {
    const responseId = `fixture-${turn}`
    s.send({ type: 'audio', responseId, pcm: s.pcm(7680) })
    for (let frame = 0; frame < 15; frame++) expect(s.render()[0]).toBe(0.25)
    if (turn % 2) {
      s.send({ type: 'clear', requestId: `clear-${turn}` })
      s.send({ type: 'audio', responseId, pcm: s.pcm(3840) })
      s.send({ type: 'done', responseId })
      expect([...s.render()].every(sample => sample === 0)).toBe(true)
    } else {
      s.send({ type: 'done', responseId })
      for (let frame = 15; frame < 60; frame++) expect(s.render()[0]).toBe(0.25)
    }
  }
  expect(s.events.filter(event => event.status === 'completed')).toHaveLength(10)
  expect(s.events.filter(event => event.status === 'interrupted')).toHaveLength(10)
  expect(s.events.filter(event => event.type === 'error')).toHaveLength(0)
})
it('renders 30 simulated minutes across circular-buffer wraps without losing, repeating or muting samples', () => {
  const s = clock(), total = 24000 * 30 * 60
  const chunks = Array.from({ length: 16 }, (_, phase) => {
    const bytes = new Uint8Array(48000), view = new DataView(bytes.buffer)
    for (let index = 0; index < 24000; index++) view.setInt16(index * 2, (phase * 24000 + index) % 1024 - 512, true)
    return bytes
  })
  let supplied = 0, rendered = 0
  while (rendered < total) {
    if (supplied < total && s.node.write - s.node.read <= 24000) {
      s.send({ type: 'audio', responseId: 'long-fixture', pcm: chunks[supplied / 24000 % 16] }); supplied += 24000
      if (supplied === total) s.send({ type: 'done', responseId: 'long-fixture' })
    }
    const output = s.render()
    for (const sample of output) {
      if (sample !== (rendered % 1024 - 512) / 32768) throw new Error(`Invalid output at synthetic sample ${rendered}`)
      rendered++
    }
  }
  expect(supplied).toBe(total)
  expect(s.events.filter(event => event.status === 'completed')).toEqual([
    expect.objectContaining({ playedUntilMs: 1800000, responseId: 'long-fixture' })
  ])
  expect(s.events.some(event => event.type === 'error' || event.status === 'underrun')).toBe(false)
  expect([...s.render()].every(sample => sample === 0)).toBe(true)
}, 60000)
