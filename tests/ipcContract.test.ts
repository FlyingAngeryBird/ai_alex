import { describe, expect, it } from 'vitest'

describe('IPC contract', () => {
  it('exposes only the approved renderer channels', async () => {
    const { exposedChannels } = await import('../electron/preload/index')

    expect(exposedChannels).toEqual([
      'app.getRuntimeState',
      'app.requestMicrophoneAccess',
      'chat.sendMessage',
      'chat.streamMessage',
      'config.get',
      'config.update',
      'music.addSearchHistory',
      'music.authorize',
      'music.clearSearchHistory',
      'music.getLibrary',
      'music.getPlaybackState',
      'music.pause',
      'music.play',
      'music.resume',
      'music.search',
      'music.toggleFavorite',
      'tts.speak',
      'tts.startStreaming',
      'tts.pushText',
      'tts.stopStreaming',
      'voice.startRecording',
      'voice.startRealtime',
      'voice.pushRealtimeAudio',
      'voice.stopRealtime',
      'voice.stopAndTranscribe'
    ])
  })

  it('exposes only the approved event channels', async () => {
    const { eventChannels } = await import('../electron/preload/index')

    expect(eventChannels).toEqual(['chat.streamChunk', 'tts.streamAudio'])
  })
})
