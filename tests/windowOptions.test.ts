import { describe, expect, it } from 'vitest'
import { createMainWindowOptions } from '../electron/main/windowOptions'

describe('main window options', () => {
  it('runs the preload bridge outside renderer sandbox so window.lingli is exposed', () => {
    const options = createMainWindowOptions('/tmp/preload.js')

    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      preload: '/tmp/preload.js',
      sandbox: false
    })
  })
})
