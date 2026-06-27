import { describe, expect, it } from 'vitest'

describe('IPC contract', () => {
  it('exposes only the approved renderer channels', async () => {
    const { exposedChannels } = await import('../electron/preload/index')

    expect(exposedChannels).toEqual([
      'app.getRuntimeState',
      'chat.sendMessage',
      'music.authorize',
      'music.getPlaybackState',
      'music.pause',
      'music.play',
      'music.resume',
      'music.search',
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
})
