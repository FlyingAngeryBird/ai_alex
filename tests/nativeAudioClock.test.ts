import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
it('renders continuous PCM under one clock and reports only consumed samples before interruption', () => {
  const events: Array<Record<string, unknown>> = []
  let Processor: any
  runInNewContext(readFileSync('public/native-duplex-worklet.js', 'utf8'), {
    AudioWorkletProcessor: class { port = { postMessage: (event: Record<string, unknown>) => events.push(event), onmessage: null } },
    sampleRate: 48000, Uint8Array, DataView, registerProcessor: (_name: string, value: unknown) => { Processor = value }
  })
  const node = new Processor()
  const send = (data: Record<string, unknown>) => node.port.onmessage({ data })
  send({ type: 'audio', responseId: 'one', pcm: new Uint8Array(48000) })
  for (let i = 0; i < 75; i++) node.process([], [[new Float32Array(128)]])
  send({ type: 'clear', requestId: 'clear' })
  expect(events.find(event => event.status === 'interrupted')).toMatchObject({ responseId: 'one', playedUntilMs: 200 })
  expect(events.at(-1)).toEqual({ type: 'cleared', requestId: 'clear' })
  send({ type: 'audio', responseId: 'one', pcm: new Uint8Array(48000) })
  expect(node.write).toBe(0)
  send({ type: 'audio', responseId: 'two', pcm: new Uint8Array(4800) }); send({ type: 'done', responseId: 'two' })
  for (let i = 0; i < 38; i++) node.process([], [[new Float32Array(128)]])
  expect(events.find(event => event.status === 'completed')).toMatchObject({ responseId: 'two', playedUntilMs: 100 })
})
it('persists played range separately from generated text and keeps temporary receipts in memory', () => {
  const db = openR1Database(':memory:')
  try {
    const store = new R1Conversations(db)
    for (const temporary of [false, true]) {
      const sessionId = store.start(temporary)
      store.append({ sessionId, turnId: 'turn', responseId: 'r', role: 'assistant', body: '完整生成但没有完整播出', status: 'generated' })
      store.recordPlayback({ sessionId, responseId: 'r', playedUntilMs: 200, status: 'interrupted' })
      store.recordPlayback({ sessionId, responseId: 'r', playedUntilMs: 500, status: 'completed' })
      expect(store.messages(sessionId)[0]).toMatchObject({ status: 'interrupted', playedUntilMs: 200 })
      if (temporary) expect(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId)).toMatchObject({ n: 0 })
    }
  } finally { db.close() }
})

it('keeps partial generated text for history while omitting unconfirmed speech from the model context', async () => {
  const { NativePlaybackLedger } = await import('../electron/main/r1/nativePlayback')
  const db = openR1Database(':memory:')
  try {
    const store = new R1Conversations(db), sessionId = store.start()
    store.append({ sessionId, turnId: 'turn', role: 'user', body: '请回答', status: 'final' })
    const ledger = new NativePlaybackLedger(store, sessionId)
    ledger.receive({ type: 'response.output_text.delta', response_id: 'r', delta: '没听完的回答' }, 'turn')
    ledger.receive({ type: 'response.output_audio.delta', response_id: 'r', delta: Buffer.alloc(48000).toString('base64') }, 'turn')
    ledger.playback({ responseId: 'r', playedUntilMs: 200, status: 'interrupted' })
    ledger.receive({ type: 'response.output_text.done', response_id: 'r', text: '迟到全文' }, 'next-turn')
    expect(store.messages(sessionId)[1]).toMatchObject({ body: '没听完的回答', turnId: 'turn', status: 'interrupted', playedUntilMs: 200 })
    expect(store.modelTurns(sessionId)[1]).toMatchObject({ text: '', heardText: null, status: 'interrupted' })
    expect(() => ledger.playback({ responseId: 'r', playedUntilMs: 2000, status: 'completed' })).toThrow('INVALID_PLAYBACK_RECEIPT')
    expect(store.messages(sessionId)).toHaveLength(2)
  } finally { db.close() }
})
it('records complete playback even when final text arrives after the playback receipt', async () => {
  const { NativePlaybackLedger } = await import('../electron/main/r1/nativePlayback')
  const db = openR1Database(':memory:')
  try {
    const store = new R1Conversations(db), sessionId = store.start(true), ledger = new NativePlaybackLedger(store, sessionId)
    ledger.receive({ type: 'response.output_audio.delta', response_id: 'r', delta: Buffer.alloc(4800).toString('base64') }, 'source-turn')
    expect(() => ledger.playback({ responseId: 'r', playedUntilMs: 100, status: 'completed' })).toThrow('INVALID_PLAYBACK_COMPLETION')
    ledger.receive({ type: 'response.output_audio.done', response_id: 'r' }, 'source-turn')
    ledger.playback({ responseId: 'r', playedUntilMs: 100, status: 'completed' })
    ledger.receive({ type: 'response.output_text.done', response_id: 'r', text: '完整回答' }, 'other-turn')
    expect(store.messages(sessionId)[0]).toMatchObject({ turnId: 'source-turn', status: 'heard', playedUntilMs: 100 })
    expect(store.modelTurns(sessionId)[0]).toMatchObject({ text: '完整回答', heardText: '完整回答', status: 'valid' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toMatchObject({ n: 0 })
  } finally { db.close() }
})

it('never restores generated native text as heard context before its first playback receipt', async () => {
  const { NativePlaybackLedger } = await import('../electron/main/r1/nativePlayback')
  const db = openR1Database(':memory:')
  try {
    const conversations = new R1Conversations(db), sessionId = conversations.start(), ledger = new NativePlaybackLedger(conversations, sessionId)
    ledger.receive({ type: 'response.output_text.done', response_id: 'unplayed', text: '尚未播放的结论' }, 'turn')
    expect(conversations.messages(sessionId)[0]).toMatchObject({ body: '尚未播放的结论', status: 'generated', playedUntilMs: 0 })
    expect(conversations.modelTurns(sessionId)[0]).toMatchObject({ text: '', heardText: null, status: 'interrupted' })
  } finally { db.close() }
})
