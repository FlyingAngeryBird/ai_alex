import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

describe('IPC contract', () => {
  it('exposes only the approved renderer channels', async () => {
    const preloadPath = '../electron/preload/index' + '.ts'
    const { exposedChannels } = (await import(preloadPath)) as typeof import('../electron/preload/index')

    assert.deepEqual(exposedChannels, [
      'app.getRuntimeState',
      'chat.sendMessage',
      'music.authorize',
      'music.getPlaybackState',
      'music.pause',
      'music.play',
      'music.resume',
      'music.search',
      'tts.speak',
      'voice.startRecording',
      'voice.stopAndTranscribe'
    ])
  })
})
