import { describe, expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1PersonaStore } from '../electron/main/r1/persona'

describe('R1 persona version and limits', () => {
  it('persists a renamed persona, rejects stale edits and validates codepoint limits', () => {
    const db = openR1Database(':memory:')
    try {
      const persona = new R1PersonaStore(db)
      const original = persona.get()
      expect(original).toMatchObject({ assistantName: 'Seamo AI', version: 1 })
      const saved = persona.update({ expectedVersion: original.version,
        assistantName: 'Alex', userAddress: '海', style: '回答简短、清晰', voiceId: 'voice-1' })
      expect(saved).toMatchObject({ assistantName: 'Alex', userAddress: '海',
        style: '回答简短、清晰', voiceId: 'voice-1', version: 2 })
      expect(new R1PersonaStore(db).get()).toEqual(saved)
      expect(() => persona.update({ expectedVersion: 1, assistantName: '旧名' }))
        .toThrow('VERSION_CONFLICT')
      expect(() => persona.update({ expectedVersion: 2, assistantName: '字'.repeat(21) }))
        .toThrow('INVALID_ASSISTANT_NAME')
      expect(persona.get()).toEqual(saved)
    } finally { db.close() }
  })
})
