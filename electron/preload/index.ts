import { createRequire } from 'node:module'

export const exposedChannels = [
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
] as const

export type ExposedChannel = (typeof exposedChannels)[number]

const exposedChannelSet = new Set<string>(exposedChannels)
const require = createRequire(import.meta.url)

type ContextBridge = {
  exposeInMainWorld(apiKey: string, api: unknown): void
}

type IpcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
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

function exposeLingliApi(
  bridge: ContextBridge,
  renderer: IpcRenderer
): void {
  bridge.exposeInMainWorld('lingli', {
    invoke: <T>(channel: ExposedChannel, payload?: unknown): Promise<T> => {
      assertExposedChannel(channel)
      return renderer.invoke(channel, payload) as Promise<T>
    }
  })
}

if (process.versions.electron) {
  const electron = require('electron') as ElectronRuntime
  exposeLingliApi(electron.contextBridge, electron.ipcRenderer)
}
