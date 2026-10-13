import { describe, expect, it } from 'vitest'

describe('IPC contract', () => {
  it('exposes only the approved renderer channels', async () => {
    const { exposedChannels } = await import('../electron/preload/index')

    expect(exposedChannels).toEqual([
      'app.getRuntimeState',
      'app.requestMicrophoneAccess',
      'chat.sendMessage',
      'chat.greeting',
      'chat.streamMessage',
      'chat.setTemporary',
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
      'r1.items.list',
      'r1.persona.get',
      'r1.persona.update',
      'r1.memory.list',
      'r1.memory.addManual',
      'r1.memory.update',
      'r1.memory.sources',
      'r1.memory.forget',
      'r1.items.create',
      'r1.items.update',
      'r1.items.complete',
      'r1.items.deletionPreview',
      'r1.items.delete',
      'r1.reminders.list',
      'r1.reminders.create',
      'r1.reminders.reschedule',
      'r1.reminders.cancel',
      'r1.credentials.status',
      'r1.credentials.save',
      'r1.search.web',
      'r1.search.open',
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

    expect(eventChannels).toEqual(['chat.streamChunk', 'tts.streamAudio', 'r1.reminderDue'])
  })
})
