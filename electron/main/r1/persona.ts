import { inTransaction, type R1Database } from './database.js'

export type R1Persona = {
  assistantName: string
  userAddress: string
  style: string
  voiceId: string
  version: number
}

type PersonaRow = {
  assistant_name: string
  user_address: string
  style: string
  voice_id: string
  version: number
}

type PersonaChange = Partial<Omit<R1Persona, 'version'>> & { expectedVersion: number }

function read(row: PersonaRow): R1Persona {
  return { assistantName: row.assistant_name, userAddress: row.user_address,
    style: row.style, voiceId: row.voice_id, version: row.version }
}

function checkedText(value: unknown, max: number, allowEmpty: boolean, code: string): string {
  if (typeof value !== 'string') throw new Error(code)
  const text = value.trim()
  if ((!allowEmpty && !text) || [...text].length > max) throw new Error(code)
  return text
}

export class R1PersonaStore {
  constructor(private readonly db: R1Database) {}

  get(): R1Persona {
    const row = this.db.prepare('SELECT assistant_name, user_address, style, voice_id, version FROM persona WHERE id = 1')
      .get() as PersonaRow | undefined
    if (!row) throw new Error('PERSONA_NOT_FOUND')
    return read(row)
  }

  update(input: PersonaChange): R1Persona {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new Error('INVALID_PERSONA_PATCH')
    }
    const allowed = new Set(['assistantName', 'userAddress', 'style', 'voiceId', 'expectedVersion'])
    if (Object.keys(input).some((key) => !allowed.has(key)) ||
      !Object.keys(input).some((key) => key !== 'expectedVersion')) {
      throw new Error('INVALID_PERSONA_PATCH')
    }
    return inTransaction(this.db, () => {
      const current = this.get()
      if (current.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
      const next = {
        assistantName: input.assistantName === undefined ? current.assistantName
          : checkedText(input.assistantName, 20, false, 'INVALID_ASSISTANT_NAME'),
        userAddress: input.userAddress === undefined ? current.userAddress
          : checkedText(input.userAddress, 20, true, 'INVALID_USER_ADDRESS'),
        style: input.style === undefined ? current.style
          : checkedText(input.style, 2000, true, 'INVALID_PERSONA_STYLE'),
        voiceId: input.voiceId === undefined ? current.voiceId
          : checkedText(input.voiceId, 200, true, 'INVALID_VOICE_ID')
      }
      this.db.prepare(`UPDATE persona SET assistant_name = ?, user_address = ?, style = ?,
        voice_id = ?, version = version + 1, updated_at = ? WHERE id = 1`)
        .run(next.assistantName, next.userAddress, next.style, next.voiceId,
          new Date().toISOString())
      return this.get()
    })
  }
}
