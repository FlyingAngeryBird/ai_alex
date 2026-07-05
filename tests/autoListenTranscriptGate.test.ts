import { describe, expect, it } from 'vitest'
import { evaluateAutoListenTranscript } from '../src/services/autoListenTranscriptGate'

describe('auto listen transcript gate', () => {
  it('rejects empty text, filler sounds, and very short accidental captures', () => {
    expect(evaluateAutoListenTranscript('   ')).toMatchObject({
      accepted: false,
      reason: 'empty'
    })
    expect(evaluateAutoListenTranscript('嗯嗯。')).toMatchObject({
      accepted: false,
      reason: 'filler'
    })
    expect(evaluateAutoListenTranscript('开', { durationMs: 320 })).toMatchObject({
      accepted: false,
      reason: 'too_short'
    })
  })

  it('keeps useful short conversational replies and music controls', () => {
    expect(evaluateAutoListenTranscript('你好')).toMatchObject({
      accepted: true,
      text: '你好'
    })
    expect(evaluateAutoListenTranscript('在吗？')).toMatchObject({
      accepted: true,
      text: '在吗？'
    })
    expect(evaluateAutoListenTranscript('下一首')).toMatchObject({
      accepted: true,
      text: '下一首'
    })
  })

  it('accepts normal sentences even when they contain punctuation', () => {
    expect(evaluateAutoListenTranscript('我今天有点累，想聊一会儿。')).toMatchObject({
      accepted: true,
      text: '我今天有点累，想聊一会儿。'
    })
  })
})
