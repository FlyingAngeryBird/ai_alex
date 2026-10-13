import { describe, expect, it, vi } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { registerR1Handlers } from '../electron/main/ipc/r1Handlers'

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))

describe('R1 memory IPC temporary boundary', () => {
  it('blocks reading and writing memory while temporary mode is active', () => {
    const db = openR1Database(':memory:')
    try {
      const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
      const ipc = { handle: (channel: string, handler: (event: unknown, payload?: unknown) => unknown) => {
        handlers.set(channel, handler)
      } }
      const mode = { temporary: true }
      registerR1Handlers(db, ipc, mode)
      const list = handlers.get('r1.memory.list') as (event: unknown) => unknown
      const add = handlers.get('r1.memory.addManual') as (event: unknown, payload: unknown) => unknown
      expect(list(null)).toMatchObject({ ok: false,
        error: { code: 'MEMORY_UNAVAILABLE_IN_TEMPORARY_SESSION' } })
      expect(add(null, { content: '秘密', category: 'profile' })).toMatchObject({ ok: false,
        error: { code: 'MEMORY_UNAVAILABLE_IN_TEMPORARY_SESSION' } })
      expect(db.prepare('SELECT COUNT(*) AS count FROM memory').get()).toMatchObject({ count: 0 })
      mode.temporary = false
      expect(add(null, { content: '喜欢茶', category: 'preference' }))
        .toMatchObject({ ok: true, data: { content: '喜欢茶' } })
    } finally { db.close() }
  })
})
