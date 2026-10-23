import { ipcMain, systemPreferences } from 'electron'

type AppResult<T> =
  | {
      ok: true
      data: T
    }
  | {
      ok: false
      error: {
        code: string
        message: string
      }
    }

type RuntimeState = {
  musicConfigured: boolean
  musicProvider: 'gdstudio'
  platform: NodeJS.Platform
  ready: true
}

type MicrophoneAccessStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown'

type MicrophoneAccessResult = {
  granted: boolean
  status: MicrophoneAccessStatus
}

type IpcMainLike = {
  handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void
}

type MicrophoneAccessProvider = {
  askForMicrophoneAccess(): Promise<MicrophoneAccessResult>
}

function ok<T>(data: T): AppResult<T> {
  return {
    ok: true,
    data
  }
}

function fail(code: string, message: string): AppResult<never> {
  return {
    ok: false,
    error: {
      code,
      message
    }
  }
}

function normalizeMediaStatus(status: string): MicrophoneAccessStatus {
  if (
    status === 'not-determined' ||
    status === 'granted' ||
    status === 'denied' ||
    status === 'restricted' ||
    status === 'unknown'
  ) {
    return status
  }

  return 'unknown'
}

function getMusicRuntimeState(): Pick<RuntimeState, 'musicConfigured' | 'musicProvider'> {
  return {
    musicConfigured: true,
    musicProvider: 'gdstudio'
  }
}

function createElectronMicrophoneAccessProvider(): MicrophoneAccessProvider {
  return {
    async askForMicrophoneAccess() {
      if (process.platform !== 'darwin') {
        return {
          granted: true,
          status: 'unknown'
        }
      }

      const beforeStatus = normalizeMediaStatus(systemPreferences.getMediaAccessStatus('microphone'))

      if (beforeStatus === 'granted') {
        return {
          granted: true,
          status: beforeStatus
        }
      }

      const granted = await systemPreferences.askForMediaAccess('microphone')
      const afterStatus = normalizeMediaStatus(systemPreferences.getMediaAccessStatus('microphone'))

      return {
        granted,
        status: afterStatus
      }
    }
  }
}

export function registerAppHandlers(
  ipc: IpcMainLike = ipcMain,
  microphoneAccess: MicrophoneAccessProvider = createElectronMicrophoneAccessProvider()
): void {
  ipc.handle('app.getRuntimeState', () =>
    ok<RuntimeState>({
      ...getMusicRuntimeState(),
      platform: process.platform,
      ready: true
    })
  )

  ipc.handle('app.requestMicrophoneAccess', async () => {
    try {
      return ok(await microphoneAccess.askForMicrophoneAccess())
    } catch (error) {
      return fail(
        'MICROPHONE_PERMISSION_FAILED',
        error instanceof Error ? error.message : '无法请求麦克风权限'
      )
    }
  })
}
