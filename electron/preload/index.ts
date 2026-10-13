import { createRequire } from 'node:module'
import type { R1Api, R1Result } from '../shared/r1Api.js'

export const exposedChannels = [
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
  'r1.items.create',
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
] as const

export type ExposedChannel = (typeof exposedChannels)[number]

export const eventChannels = [
  'chat.streamChunk',
  'tts.streamAudio',
  'r1.reminderDue'
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
  const invokeR1 = <T>(channel: ExposedChannel, payload?: unknown): Promise<R1Result<T>> => {
    assertExposedChannel(channel)
    return renderer.invoke(channel, payload) as Promise<R1Result<T>>
  }
  const r1Api: R1Api = {
    items: {
      list: () => invokeR1('r1.items.list'),
      create: (input) => invokeR1('r1.items.create', input),
      complete: (input) => invokeR1('r1.items.complete', input),
      deletionPreview: (itemId) => invokeR1('r1.items.deletionPreview', { itemId }),
      delete: (input) => invokeR1('r1.items.delete', input)
    },
    credentials: {
      status: () => invokeR1('r1.credentials.status'),
      save: (patch) => invokeR1('r1.credentials.save', patch)
    },
    search: {
      web: (query) => invokeR1('r1.search.web', { query }),
      open: (candidateId) => invokeR1('r1.search.open', { candidateId })
    },
    reminders: {
      list: () => invokeR1('r1.reminders.list'),
      create: (input) => invokeR1('r1.reminders.create', input),
      reschedule: (input) => invokeR1('r1.reminders.reschedule', input),
      cancel: (input) => invokeR1('r1.reminders.cancel', input),
      onDue: (handler) => {
        const listener = (...args: unknown[]): void => handler(args[1] as Parameters<typeof handler>[0])
        renderer.on('r1.reminderDue', listener)
        return () => renderer.removeListener('r1.reminderDue', listener)
      }
    }
  }
  bridge.exposeInMainWorld('seamoR1', r1Api)
}

if (process.versions.electron) {
  const electron = require('electron') as ElectronRuntime
  exposeLingliApi(electron.contextBridge, electron.ipcRenderer)
}
