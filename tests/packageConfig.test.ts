import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  build?: {
    mac?: {
      extendInfo?: Record<string, string>
    }
  }
  scripts?: Record<string, string>
}

describe('desktop package configuration', () => {
  it('provides clear commands for starting and packaging the macOS app', () => {
    expect(packageJson.scripts).toMatchObject({
      'dist:mac': 'npm run build && node scripts/package-mac.mjs',
      start: 'npm run build && electron .'
    })
  })

  it('declares the macOS microphone permission reason for packaged builds', () => {
    expect(packageJson.build?.mac?.extendInfo).toMatchObject({
      NSMicrophoneUsageDescription:
        'lingmo 需要使用麦克风来完成语音对话和实时语音识别。'
    })
  })

  it('provides the microphone permission plist used by Electron Packager', () => {
    expect(readFileSync('build/Info.plist', 'utf8')).toContain(
      'NSMicrophoneUsageDescription'
    )
  })

  it('provides a deterministic local macOS packaging script', () => {
    const script = readFileSync('scripts/package-mac.mjs', 'utf8')

    expect(script).toContain('release/lingmo-darwin-arm64/lingmo.app')
    expect(script).toContain('NSMicrophoneUsageDescription')
    expect(script).toContain('icudtl.dat')
    expect(script).toContain('verbatimSymlinks: true')
    expect(script).toContain('renameMainExecutable')
    expect(script).toContain("join(macOsDir, 'lingmo')")
    expect(script).toContain('signForLocalDevelopment')
    expect(script).toContain("'codesign'")
    expect(script).toContain("'--sign'")
    expect(script).toContain("'.env'")
    expect(script).toContain('lingmo 需要使用麦克风来完成语音对话和实时语音识别。')
  })
})
