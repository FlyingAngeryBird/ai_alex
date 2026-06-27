import { describe, expect, it } from 'vitest'
import { useConversation } from '../src/composables/useConversation'
import { useMusic } from '../src/composables/useMusic'

describe('UI prototype state', () => {
  it('moves through the simulated conversation and detects music intent', async () => {
    const conversation = useConversation({ delayMs: 0 })

    conversation.startListening()
    const result = await conversation.stopListening('想听一点音乐')

    expect(result.intent).toBe('play_music')
    expect(conversation.particleState.value).toBe('idle')
    expect(conversation.messages.value.map((message) => message.role)).toEqual([
      'assistant',
      'user',
      'assistant'
    ])
  })

  it('arms auto listen and pauses it while the assistant speaks', async () => {
    const conversation = useConversation({ delayMs: 0 })

    conversation.toggleAutoListen()
    expect(conversation.autoListenState.value).toBe('armed')

    conversation.startListening()
    expect(conversation.autoListenState.value).toBe('speech_detected')

    await conversation.stopListening('我今天想聊聊天')
    expect(conversation.autoListenState.value).toBe('armed')
    expect(conversation.particleState.value).toBe('idle')
  })

  it('keeps music playback state available after leaving immersive view', () => {
    const music = useMusic()

    music.startDemoTrack()
    music.closeImmersive()
    music.togglePlayback()

    expect(music.viewMode.value).toBe('conversation')
    expect(music.playback.value.track?.title).toBe('午夜漫游')
    expect(music.playback.value.status).toBe('paused')

    music.togglePlayback()

    expect(music.playback.value.status).toBe('playing')
  })
})
