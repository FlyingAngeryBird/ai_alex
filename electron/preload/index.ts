import { createRequire } from 'node:module'

export const exposedChannels = [
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
] as const

export type ExposedChannel = (typeof exposedChannels)[number]

export const eventChannels = [
  'chat.streamChunk',
  'tts.streamAudio'
] as const

export type ExposedEventChannel = (typeof eventChannels)[number]

const exposedChannelSet = new Set<string>(exposedChannels)
const eventChannelSet = new Set<string>(eventChannels)
const require = createRequire(import.meta.url)

type ContextBridge = {
  exposeInMainWorld(apiKey: string, api: unknown): void
}

type IpcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (...args: unknown[]) => void): void
  removeListener(channel: string, listener: (...args: unknown[]) => void): void
}

type ElectronRuntime = {
  contextBridge: ContextBridge
  ipcRenderer: IpcRenderer
}

function assertExposedChannel(channel: string): asserts channel is ExposedChannel {
  if (!exposedChannelSet.has(channel)) {
    throw new Error(`IPC channel is not exposed: ${channel}`)
  }
}

function assertExposedEventChannel(channel: string): asserts channel is ExposedEventChannel {
  if (!eventChannelSet.has(channel)) {
    throw new Error(`IPC event channel is not exposed: ${channel}`)
  }
}

function exposeLingliApi(
  bridge: ContextBridge,
  renderer: IpcRenderer
): void {
  bridge.exposeInMainWorld('lingli', {
    invoke: <T>(channel: ExposedChannel, payload?: unknown): Promise<T> => {
      assertExposedChannel(channel)
      return renderer.invoke(channel, payload) as Promise<T>
    },
    on: <T>(channel: ExposedEventChannel, handler: (payload: T) => void): (() => void) => {
      assertExposedEventChannel(channel)
      const listener = (...args: unknown[]): void => handler(args[1] as T)
      renderer.on(channel, listener)
      return () => {
        renderer.removeListener(channel, listener)
      }
    }
  })
}

if (process.versions.electron) {
  const electron = require('electron') as ElectronRuntime
  exposeLingliApi(electron.contextBridge, electron.ipcRenderer)
}
