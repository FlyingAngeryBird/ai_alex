import { describe, expect, it, vi } from 'vitest'
import {
  createConfigStore,
  createDefaultConfig,
  mergeConfig,
  migrateConfig
} from '../electron/main/config/configStore'

function createFakeFs(storedJson: string | null = null) {
  return {
    readFile: vi.fn(async () => {
      if (storedJson === null) {
        throw new Error('ENOENT')
      }

      return storedJson
    }),
    writeFile: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined)
  }
}

describe('configStore', () => {
  it('returns default config when file is missing', async () => {
    const store = createConfigStore({ filePath: '/tmp/config.json', fs: createFakeFs(null) })

    const config = await store.loadConfig()

    expect(config.persona.systemPrompt).toBe(createDefaultConfig().persona.systemPrompt)
    expect(config.voice.voices).toEqual([])
    expect(config.voice.activeVoiceId).toBe('')
  })

  it('loads new format voices and activeVoiceId', async () => {
    const fs = createFakeFs(
      JSON.stringify({
        voice: {
          voices: [{ id: 'ICL_a', name: '温柔女声' }],
          activeVoiceId: 'ICL_a'
        }
      })
    )
    const store = createConfigStore({ filePath: '/tmp/config.json', fs })

    const config = await store.loadConfig()

    expect(config.voice.voices).toEqual([{ id: 'ICL_a', name: '温柔女声' }])
    expect(config.voice.activeVoiceId).toBe('ICL_a')
  })

  it('migrates legacy voiceId format to voices and activeVoiceId', async () => {
    const fs = createFakeFs(JSON.stringify({ voice: { voiceId: 'ICL_legacy' } }))
    const store = createConfigStore({ filePath: '/tmp/config.json', fs })

    const config = await store.loadConfig()

    expect(config.voice.activeVoiceId).toBe('ICL_legacy')
    expect(config.voice.voices).toEqual([{ id: 'ICL_legacy', name: '已导入音色' }])
  })

  it('updates voices and persists to disk', async () => {
    const fs = createFakeFs(null)
    const store = createConfigStore({ filePath: '/tmp/config.json', fs })
    await store.loadConfig()

    const updated = await store.updateConfig({
      voice: {
        voices: [{ id: 'ICL_new', name: '新音色' }],
        activeVoiceId: 'ICL_new'
      }
    })

    expect(updated.voice.voices).toEqual([{ id: 'ICL_new', name: '新音色' }])
    expect(updated.voice.activeVoiceId).toBe('ICL_new')
    expect(store.getConfig().voice.activeVoiceId).toBe('ICL_new')
    expect(fs.writeFile).toHaveBeenCalledWith(
      '/tmp/config.json',
      expect.stringContaining('ICL_new'),
      'utf8'
    )
  })

  it('falls back to default config when disk json is malformed', async () => {
    const fs = createFakeFs('not-json')
    const store = createConfigStore({ filePath: '/tmp/config.json', fs })

    const config = await store.loadConfig()

    expect(config.voice.voices).toEqual([])
  })
})

describe('mergeConfig', () => {
  it('keeps current values for missing patch fields', () => {
    const base = createDefaultConfig()
    base.voice.activeVoiceId = 'existing'

    const merged = mergeConfig(base, { persona: { systemPrompt: 'new prompt' } })

    expect(merged.persona.systemPrompt).toBe('new prompt')
    expect(merged.voice.activeVoiceId).toBe('existing')
  })

  it('returns a copy when patch is undefined', () => {
    const base = createDefaultConfig()
    const merged = mergeConfig(base, undefined)

    expect(merged).toEqual(base)
    expect(merged).not.toBe(base)
  })
})

describe('migrateConfig', () => {
  it('filters voice entries missing required fields', () => {
    const migrated = migrateConfig(createDefaultConfig(), {
      voice: {
        voices: [{ id: 'ok', name: '好' }, { id: 'bad' }, null]
      }
    })

    expect(migrated.voice.voices).toEqual([{ id: 'ok', name: '好' }])
  })
})
