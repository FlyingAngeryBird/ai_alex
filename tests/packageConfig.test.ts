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
        'Seamo AI R1 需要使用麦克风来完成语音对话。'
    })
  })

  it('provides the microphone permission plist used by Electron Packager', () => {
    expect(readFileSync('build/Info.plist', 'utf8')).toContain(
      'NSMicrophoneUsageDescription'
    )
  })

  it('provides a deterministic local macOS packaging script', () => {
    const script = readFileSync('scripts/package-mac.mjs', 'utf8')

    expect(script).toContain('release/seamo-ai-r1-darwin-arm64/Seamo AI R1.app')
    expect(script).toContain('NSMicrophoneUsageDescription')
    expect(script).toContain('icudtl.dat')
    expect(script).toContain('verbatimSymlinks: true')
    expect(script).toContain('renameMainExecutable')
    expect(script).toContain("join(macOsDir, 'Seamo AI R1')")
    expect(script).toContain('signForLocalDevelopment')
    expect(script).toContain("'codesign'")
    expect(script).toContain("'--sign'")
    expect(script).not.toContain("join(appDir, '.env')")
    expect(script).toContain('Seamo AI R1 需要使用麦克风来完成语音对话。')
  })
})
