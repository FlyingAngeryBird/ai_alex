import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1PersonaStore } from '../electron/main/r1/persona'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'

describe('R1 released prompt assets', () => {
  it('loads registered and hashed assets with the active persona', () => {
    const db = openR1Database(':memory:')
    try {
      const persona = new R1PersonaStore(db)
      const saved = persona.update({ expectedVersion: 1, assistantName: 'Alex',
        userAddress: '海', style: '温和而简洁' })
      const assets = loadR1PromptAssets(resolve('r1-assets'))
      const text = assets.compose(saved, { sessionId: 'test-session', temporary: false })
      expect(assets.releaseId).toBe('seamo-ai-r1-agent-assets-1.0.1')
      expect(text).toContain('你是Seamo AI应用中的个人语音助手')
      expect(text).toContain('按assistantName称呼自己')
      expect(text).toContain('"assistantName":"Alex"')
      expect(text).toContain('"userAddress":"海"')
      expect(text).toContain('APP_CONTEXT_DATA')
      expect(text).not.toMatch(/\{\{[a-z_]+\}\}/)
    } finally { db.close() }
  })
})
