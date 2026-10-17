import { createRequire } from 'node:module'
import type { R1Api, R1Result } from '../shared/r1Api.js'

export const exposedChannels = [
  'r1.onboarding.get', 'r1.onboarding.complete',
  'r1.data.prepareCleanup', 'r1.data.confirmCleanup', 'r1.data.exportCleanupBackup',
  'r1.data.summary', 'r1.data.exportBackup', 'r1.data.prepareRestore', 'r1.data.cancelRestore', 'r1.data.confirmRestore', 'r1.data.exportDiagnostics',
  'r1.preferences.get', 'r1.preferences.update',
  'r1.music.attach', 'r1.music.detach', 'r1.music.snapshot', 'r1.music.report', 'r1.music.search', 'r1.music.control', 'r1.music.clearHistory', 'r1.music.exit',
  'app.getRuntimeState',
  'app.requestMicrophoneAccess',
  'chat.sendMessage',
  'chat.greeting',
  'chat.streamMessage',
  'chat.setTemporary',
  'chat.stopResponse',
  'r1.session.temporaryPersistence',
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
  'r1.items.export',
  'r1.persona.get',
  'r1.persona.update',
  'r1.topics.list',
  'r1.topics.details',
  'r1.topics.update',
  'r1.topics.forget',
  'r1.topics.select',
  'r1.memory.policy',
  'r1.memory.setPolicy',
  'r1.memory.prepareSelection',
  'r1.memory.list',
  'r1.memory.addManual',
  'r1.memory.update',
  'r1.memory.sources',
  'r1.memory.forget',
  'r1.memory.confirmSave',
  'r1.memory.cancelSave',
  'r1.history.list',
  'r1.history.messages',
  'r1.focus.reportMusicSelection',
  'r1.focus.getState',
  'r1.focus.start',
  'r1.focus.pause',
  'r1.focus.resume',
  'r1.focus.stop',
  'r1.tasks.selectCandidate',
  'r1.tasks.saveCandidate',
  'r1.tasks.openSource',
  'r1.tasks.list',
  'r1.tasks.prepareDelivery',
  'r1.tasks.cancelDelivery',
  'r1.tasks.reportDeliveryPlayback',
  'r1.tasks.get',
  'r1.tasks.pause',
  'r1.tasks.resume',
  'r1.tasks.cancel',
  'r1.artifacts.get',
  'r1.artifacts.select',
  'r1.artifacts.materials',
  'r1.artifacts.revise',
  'r1.artifacts.undo',
  'r1.artifacts.save',
  'r1.artifacts.export',
  'r1.items.create',
  'r1.items.update',
  'r1.items.complete',
  'r1.items.deletionPreview',
  'r1.items.delete',
  'r1.items.resolveAction',
  'r1.reminders.list',
  'r1.reminders.prepareDelivery',
  'r1.reminders.cancelDelivery',
  'r1.reminders.reportDeliveryPlayback',
  'r1.reminders.create',
  'r1.reminders.reschedule',
  'r1.reminders.cancel',
  'r1.credentials.status',
  'r1.credentials.save',
  'r1.services.check',
  'r1.services.cancel',
  'r1.search.web',
  'r1.search.open',
  'tts.speak',
  'tts.startStreaming',
  'tts.pushText',
  'tts.stopStreaming',
  'voice.nativeStart',
  'voice.nativePlayback',
  'voice.nativeAudio',
  'voice.nativeMute',
  'voice.nativeCancel',
  'voice.nativeStop',
  'voice.startRecording',
  'voice.startRealtime',
  'voice.pushRealtimeAudio',
  'voice.stopRealtime',
  'voice.stopAndTranscribe'
] as const

export type ExposedChannel = (typeof exposedChannels)[number]

export const eventChannels = [
  'r1.preferencesChanged',
  'r1.musicCommand', 'r1.musicChanged',
  'chat.streamChunk',
  'tts.streamAudio',
  'voice.nativeEvent',
  'r1.reminderDue',
  'r1.memoryInvalidated',
  'r1.artifactChanged',
  'r1.memoryConfirmation',
  'r1.memoryPolicyChanged',
  'r1.memoryChanged',
  'r1.focusChanged',
  'r1.taskChanged',
  'r1.itemAction',
  'r1.itemsChanged'
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
    onboarding: { get: () => invokeR1('r1.onboarding.get'), complete: input => invokeR1('r1.onboarding.complete', input) },
    data: {
      prepareCleanup: input => invokeR1('r1.data.prepareCleanup', input), confirmCleanup: input => invokeR1('r1.data.confirmCleanup', input),
      exportCleanupBackup: () => invokeR1('r1.data.exportCleanupBackup'),
      summary: () => invokeR1('r1.data.summary'), exportBackup: () => invokeR1('r1.data.exportBackup'),
      prepareRestore: () => invokeR1('r1.data.prepareRestore'), cancelRestore: () => invokeR1('r1.data.cancelRestore'),
      confirmRestore: input => invokeR1('r1.data.confirmRestore', input), exportDiagnostics: input => invokeR1('r1.data.exportDiagnostics', input)
    },
    preferences: {
      get: () => invokeR1('r1.preferences.get'), update: input => invokeR1('r1.preferences.update', input),
      onChanged: handler => { const listener = (...args: unknown[]) => handler(args[1] as Parameters<typeof handler>[0]); renderer.on('r1.preferencesChanged', listener); return () => renderer.removeListener('r1.preferencesChanged', listener) }
    },
    music: {
      attach: () => invokeR1('r1.music.attach'), detach: () => invokeR1('r1.music.detach'), snapshot: () => invokeR1('r1.music.snapshot'),
      report: input => invokeR1('r1.music.report', input), search: input => invokeR1('r1.music.search', input),
      control: input => invokeR1('r1.music.control', input), clearHistory: () => invokeR1('r1.music.clearHistory'),
      exit: input => invokeR1('r1.music.exit', input),
      onCommand: handler => { const listener = (...args: unknown[]) => handler(args[1] as Parameters<typeof handler>[0]); renderer.on('r1.musicCommand', listener); return () => renderer.removeListener('r1.musicCommand', listener) },
      onChanged: handler => { const listener = (...args: unknown[]) => handler(args[1] as Parameters<typeof handler>[0]); renderer.on('r1.musicChanged', listener); return () => renderer.removeListener('r1.musicChanged', listener) }
    },
    topics: {
      list: input => invokeR1('r1.topics.list', input),
      details: topicId => invokeR1('r1.topics.details', { topicId }),
      update: input => invokeR1('r1.topics.update', input),
      forget: input => invokeR1('r1.topics.forget', input),
      select: input => invokeR1('r1.topics.select', input)
    },
    tasks: {
      reportDeliveryPlayback: input => invokeR1('r1.tasks.reportDeliveryPlayback', input),
      prepareDelivery: input => invokeR1('r1.tasks.prepareDelivery', input),
      cancelDelivery: input => invokeR1('r1.tasks.cancelDelivery', input),
      selectCandidate: input => invokeR1('r1.tasks.selectCandidate', input),
      saveCandidate: input => invokeR1('r1.tasks.saveCandidate', input),
      openSource: input => invokeR1('r1.tasks.openSource', input),
      list: () => invokeR1('r1.tasks.list'),
      get: taskId => invokeR1('r1.tasks.get', { taskId }),
      pause: input => invokeR1('r1.tasks.pause', input),
      resume: input => invokeR1('r1.tasks.resume', input),
      cancel: input => invokeR1('r1.tasks.cancel', input),
      onChanged: handler => {
        const listener = (_event: unknown, payload: unknown) => handler(payload as Parameters<typeof handler>[0])
        renderer.on('r1.taskChanged', listener)
        return () => renderer.removeListener('r1.taskChanged', listener)
      }
    },
    artifacts: {
      select: input => invokeR1('r1.artifacts.select', input),
      materials: artifactId => invokeR1('r1.artifacts.materials', { artifactId }),
      onChanged: handler => {
        const listener = (...args: unknown[]): void => handler(args[1] as Parameters<typeof handler>[0])
        renderer.on('r1.artifactChanged', listener)
        return () => renderer.removeListener('r1.artifactChanged', listener)
      },
      export: input => invokeR1('r1.artifacts.export', input),
      get: input => invokeR1('r1.artifacts.get', input),
      revise: input => invokeR1('r1.artifacts.revise', input),
      undo: input => invokeR1('r1.artifacts.undo', input),
      save: input => invokeR1('r1.artifacts.save', input)
    },
    persona: {
      get: () => invokeR1('r1.persona.get'),
      update: (input) => invokeR1('r1.persona.update', input)
    },
    memory: {
      policy: () => invokeR1('r1.memory.policy'),
      setPolicy: input => invokeR1('r1.memory.setPolicy', input),
      prepareSelection: input => invokeR1('r1.memory.prepareSelection', input),
      onPolicyChanged: handler => {
        const listener = (_event: unknown, value: unknown) => handler(value as Parameters<typeof handler>[0])
        renderer.on('r1.memoryPolicyChanged', listener)
        return () => renderer.removeListener('r1.memoryPolicyChanged', listener)
      },
      onChanged: handler => {
        const listener = () => handler()
        renderer.on('r1.memoryChanged', listener)
        return () => renderer.removeListener('r1.memoryChanged', listener)
      },
      confirmSave: confirmationId => invokeR1('r1.memory.confirmSave', { confirmationId }),
      cancelSave: confirmationId => invokeR1('r1.memory.cancelSave', { confirmationId }),
      onConfirmation: handler => {
        const listener = (_event: unknown, value: unknown) => handler(value as Parameters<typeof handler>[0])
        renderer.on('r1.memoryConfirmation', listener)
        return () => renderer.removeListener('r1.memoryConfirmation', listener)
      },
      list: (input) => invokeR1('r1.memory.list', input),
      addManual: (input) => invokeR1('r1.memory.addManual', input),
      update: (input) => invokeR1('r1.memory.update', input),
      sources: (memoryId) => invokeR1('r1.memory.sources', { memoryId }),
      forget: (memoryId, expectedVersion) => invokeR1('r1.memory.forget', { memoryId, expectedVersion }),
      onInvalidated: (handler) => {
        const listener = (...args: unknown[]): void => handler(args[1] as { deletionEpoch: number })
        renderer.on('r1.memoryInvalidated', listener)
        return () => renderer.removeListener('r1.memoryInvalidated', listener)
      }
    },
    history: {
      list: (input) => invokeR1('r1.history.list', input),
      messages: (sessionId) => invokeR1('r1.history.messages', { sessionId })
    },
    focus: {
      reportMusicSelection: input => invokeR1('r1.focus.reportMusicSelection', input),
      getState: () => invokeR1('r1.focus.getState'),
      start: input => invokeR1('r1.focus.start', input),
      pause: input => invokeR1('r1.focus.pause', input),
      resume: input => invokeR1('r1.focus.resume', input),
      stop: input => invokeR1('r1.focus.stop', input),
      onChanged: handler => {
        const listener = (...args: unknown[]): void => handler(args[1] as Parameters<typeof handler>[0])
        renderer.on('r1.focusChanged', listener)
        return () => renderer.removeListener('r1.focusChanged', listener)
      }
    },
    session: {
      temporaryPersistence: input => invokeR1('r1.session.temporaryPersistence', input)
    },
    items: {
      export: input => invokeR1('r1.items.export', input),
      list: () => invokeR1('r1.items.list'),
      create: (input) => invokeR1('r1.items.create', input),
      update: (input) => invokeR1('r1.items.update', input),
      complete: (input) => invokeR1('r1.items.complete', input),
      deletionPreview: (itemId) => invokeR1('r1.items.deletionPreview', { itemId }),
      delete: (input) => invokeR1('r1.items.delete', input),
      resolveAction: (input) => invokeR1('r1.items.resolveAction', input),
      onAction: (handler) => { const listener = (...args: unknown[]) => handler(args[1] as Parameters<typeof handler>[0]); renderer.on('r1.itemAction', listener); return () => renderer.removeListener('r1.itemAction', listener) },
      onChanged: (handler) => { const listener = (...args: unknown[]) => handler(args[1] as Parameters<typeof handler>[0]); renderer.on('r1.itemsChanged', listener); return () => renderer.removeListener('r1.itemsChanged', listener) }
    },
    credentials: {
      status: () => invokeR1('r1.credentials.status'),
      save: (patch) => invokeR1('r1.credentials.save', patch)
    },
    services: {
      check: (input) => invokeR1('r1.services.check', input),
      cancel: (requestId) => invokeR1('r1.services.cancel', requestId)
    },
    search: {
      web: (query) => invokeR1('r1.search.web', { query }),
      open: (candidateId) => invokeR1('r1.search.open', { candidateId })
    },
    reminders: {
      prepareDelivery: input => invokeR1('r1.reminders.prepareDelivery', input),
      cancelDelivery: input => invokeR1('r1.reminders.cancelDelivery', input),
      reportDeliveryPlayback: input => invokeR1('r1.reminders.reportDeliveryPlayback', input),
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
