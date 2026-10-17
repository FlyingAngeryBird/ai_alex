import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1MemoryStore } from '../electron/main/r1/memory'
import { R1MemoryPolicy } from '../electron/main/r1/memoryPolicy'
import { R1PersonaStore } from '../electron/main/r1/persona'
import { R1AutomaticMemory } from '../electron/main/r1/automaticMemory'
import { R1MemoryConfirmations } from '../electron/main/r1/memoryConfirmations'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { createArkResponsesProvider } from '../electron/main/providers/arkResponsesProvider'
import { registerChatHandlers } from '../electron/main/ipc/chatHandlers'
import { R1ConversationDriver } from '../electron/main/r1/conversationDriver'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { registerAutomaticMemoryHandlers } from '../electron/main/ipc/automaticMemoryHandlers'
vi.mock('electron', () => ({ ipcMain: { handle() {} } }))
const assets = loadR1PromptAssets(resolve('r1-assets'))
const empty = { candidates: [], sensitiveSourceTurnIds: [] }
function setup(body = '我喜欢无糖茶。', temporary = false) {
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db), memory = new R1MemoryStore(db)
  const policy = new R1MemoryPolicy(db), persona = new R1PersonaStore(db), sessionId = conversations.start(temporary)
  const source = conversations.append({ sessionId, turnId: 'actual-user-turn', role: 'user', body, status: 'final' })
  let release: (output: unknown) => void = () => { throw new Error('REQUEST_NOT_STARTED') }
  let active = true, latest = true, revision = 1
  const requests: Record<string, unknown>[] = [], notifications = vi.fn(), invalidated = vi.fn(), saved = vi.fn()
  const manager = new R1MemoryConfirmations(db, { notify: notifications, onInvalidated: invalidated, onTemporaryExited() {} })
  const provider = createArkResponsesProvider({ env: { VOLCENGINE_ARK_API_KEY: 'synthetic', VOLCENGINE_ARK_MODEL: 'synthetic' },
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init!.body)))
      // Deliberately ignore AbortSignal: commit authority must still prevent late writes.
      return new Promise<Response>(resolve => { release = output => resolve(new Response(JSON.stringify({ id: 'response', status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }))) })
    } })
  const automatic = new R1AutomaticMemory(db, assets, conversations, provider, { persona: () => persona.get(), configurationRevision: () => revision,
    onInvalidated: invalidated, onSaved: saved })
  const scope = { source, temporary, timezone: 'Asia/Shanghai', assertSession() { if (!active) throw new Error('AUTO_MEMORY_SESSION_REVOKED') },
    assertLatest() { if (!latest) throw new Error('AUTO_MEMORY_SOURCE_REVOKED') }, confirmSensitive() {
      const version = policy.get().version
      manager.offerSelection({ ownerId: 7, source, temporary: false, sensitive: true, automatic: true,
        assertCurrent() { scope.assertSession(); scope.assertLatest(); policy.assertAuthorized(version) } })
    } }
  const candidate = (content = '喜欢无糖茶') => ({ content, category: 'preference', sourceTurnIds: [source.turnId], validUntil: null, supersedesMemoryIds: [] as string[] })
  return { db, conversations, memory, policy, persona, source, automatic, scope, requests, manager, notifications, invalidated, saved, candidate,
    enabled() { automatic.updatePolicy({ enabled: true, expectedVersion: policy.get().version }) },
    enqueue() { automatic.enqueue(scope) }, release(output: unknown) { release(output) }, stale() { active = false }, nextTurn() { latest = false }, changeConfig() { revision++ },
    async close() { automatic.close(); await automatic.whenIdle(); db.close() } }
}
describe('authorized automatic memory extraction', () => {
  it('defaults off, never sends temporary content, and extracts only future ordinary turns after consent', async () => {
    const s = setup()
    try {
      expect(s.policy.get()).toEqual({ enabled: false, version: 1 }); s.enqueue(); expect(s.requests).toHaveLength(0)
      s.enabled(); expect(s.requests).toHaveLength(0); s.enqueue()
      s.release({ ...empty, candidates: [s.candidate()] }); await s.automatic.whenIdle()
      expect(s.memory.list().entries).toMatchObject([{ content: '喜欢无糖茶', authorization: 'automatic', authorizationVersion: 2, sourceRefs: [s.source.messageId] }])
      expect(s.requests[0].tools).toEqual([]); expect(s.requests[0].store).toBe(false)
      expect(JSON.stringify(s.requests[0])).toContain('memory_candidates')
      s.enqueue(); expect(s.requests).toHaveLength(1)
    } finally { await s.close() }
    const temporary = setup('不能写入的临时内容', true)
    try { temporary.enabled(); temporary.enqueue(); expect(temporary.requests).toHaveLength(0); expect(temporary.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toMatchObject({ n: 0 }) } finally { await temporary.close() }
  })
  it.each(['off', 'off-on', 'session', 'forget', 'source', 'persona', 'config'] as const)('prevents a late result after %s revokes its captured authority', async reason => {
    const s = setup()
    try {
      const old = s.memory.addManual({ content: '喜欢公园', category: 'preference' })
      s.enabled(); s.enqueue()
      if (reason === 'off' || reason === 'off-on') { s.automatic.updatePolicy({ enabled: false, expectedVersion: 2 }); if (reason === 'off-on') s.enabled() }
      if (reason === 'session') s.stale()
      if (reason === 'forget') s.memory.forget(old.memoryId, old.version)
      if (reason === 'source') s.db.prepare('UPDATE messages SET body = ? WHERE message_id = ?').run('来源已修改', s.source.messageId)
      if (reason === 'persona') s.persona.update({ expectedVersion: 1, assistantName: '另一称呼' })
      if (reason === 'config') s.changeConfig()
      s.release({ ...empty, candidates: [s.candidate()] }); await s.automatic.whenIdle()
      expect(s.memory.recall('无糖茶')).toEqual([]); expect(s.saved).not.toHaveBeenCalled()
    } finally { await s.close() }
  })
  it.each(['source', 'target', 'schema'] as const)('rejects the whole proposal before any write when %s is invalid', async reason => {
    const s = setup()
    try {
      s.enabled(); s.enqueue()
      const bad = s.candidate('喜欢蓝色')
      if (reason === 'source') bad.sourceTurnIds = ['invented-turn']
      if (reason === 'target') bad.supersedesMemoryIds = ['invented-memory']
      if (reason === 'schema') Object.assign(bad, { unauthorizedExtra: true })
      s.release({ ...empty, candidates: [s.candidate(), bad] }); await s.automatic.whenIdle()
      expect(s.memory.list().entries).toEqual([]); expect(s.automatic.getState().state).toBe('failed')
    } finally { await s.close() }
  })
  it('blocks a known health write even when the model misses its sensitive source flag', async () => {
    const s = setup('我有偏头痛。')
    try {
      s.enabled(); s.enqueue(); s.release({ ...empty, candidates: [{ ...s.candidate('有偏头痛'), category: 'profile' }] }); await s.automatic.whenIdle()
      expect(s.memory.list().entries).toEqual([])
      expect(s.notifications.mock.calls.at(-1)![1]).toMatchObject({ requiresSelection: true })
    } finally { await s.close() }
  })
  it('requires selection then a second fixed-content confirmation for a mixed sensitive turn', async () => {
    const s = setup('我有偏头痛。我喜欢无糖茶。')
    try {
      s.enabled(); s.enqueue(); s.release({ candidates: [s.candidate()], sensitiveSourceTurnIds: [s.source.turnId] }); await s.automatic.whenIdle()
      expect(s.memory.list().entries).toEqual([])
      const selection = s.notifications.mock.calls.at(-1)![1]
      expect(selection).toMatchObject({ requiresSelection: true, content: s.source.body })
      expect(() => s.manager.commit(7, selection.confirmationId)).toThrow('MEMORY_SELECTION_REQUIRED')
      expect(() => s.manager.prepareSelection(8, { confirmationId: selection.confirmationId, content: '偏头痛', category: 'profile' })).toThrow('MEMORY_CONFIRMATION_NOT_FOUND')
      expect(() => s.manager.prepareSelection(7, { confirmationId: selection.confirmationId, content: '喜欢咖啡', category: 'preference' })).toThrow('MEMORY_SELECTION_NOT_FROM_SOURCE')
      const fixed = s.manager.prepareSelection(7, { confirmationId: selection.confirmationId, content: '我有偏头痛', category: 'profile' })
      expect(fixed.requiresSelection).toBeUndefined(); expect(s.memory.list().entries).toEqual([])
      const result = s.manager.commit(7, fixed.confirmationId)
      expect(result.memory).toMatchObject({ content: '我有偏头痛', authorization: 'explicit', sourceRefs: [s.source.messageId] })
      expect(s.memory.list().entries).toHaveLength(1)
      expect(JSON.stringify(s.db.prepare('SELECT payload_json FROM event_log').all())).not.toContain('偏头痛')
    } finally { await s.close() }
  })
  it.each(['cancel', 'disable', 'new-turn'] as const)('does not persist a sensitive selection after %s', async action => {
    const s = setup('我有偏头痛。')
    try {
      s.enabled(); s.enqueue(); s.release({ ...empty, sensitiveSourceTurnIds: [s.source.turnId] }); await s.automatic.whenIdle()
      const selection = s.notifications.mock.calls.at(-1)![1]
      if (action === 'cancel') s.manager.cancel(7, selection.confirmationId)
      if (action === 'disable') { s.automatic.updatePolicy({ enabled: false, expectedVersion: 2 }); s.manager.revokeAutomatic() }
      if (action === 'new-turn') s.nextTurn()
      expect(() => s.manager.prepareSelection(7, { confirmationId: selection.confirmationId, content: '我有偏头痛', category: 'profile' })).toThrow()
      expect(s.memory.list().entries).toEqual([])
    } finally { await s.close() }
  })
  it('retains real old and new sources when a correction creates a new version and invalidates contexts', async () => {
    const s = setup('我现在喜欢无糖茶。')
    try {
      const old = s.memory.addManual({ content: '喜欢咖啡', category: 'preference' })
      s.enabled(); s.enqueue(); s.release({ ...empty, candidates: [{ ...s.candidate(), supersedesMemoryIds: [old.memoryId] }] }); await s.automatic.whenIdle()
      expect(s.memory.list().entries).toMatchObject([{ memoryId: old.memoryId, version: 2, content: '喜欢无糖茶', authorization: 'automatic', sourceRefs: [...old.sourceRefs, s.source.messageId] }])
      expect(s.invalidated).toHaveBeenCalledWith(1); expect(s.conversations.modelTurns(s.source.sessionId)).toEqual([])
    } finally { await s.close() }
  })
  it('merges exact duplicate facts and preserves explicit consent when an automatic source is added', async () => {
    const s = setup()
    try {
      const explicit = s.memory.addManual({ content: '喜欢无糖茶', category: 'preference' })
      s.enabled(); s.enqueue(); s.release({ ...empty, candidates: [s.candidate()] }); await s.automatic.whenIdle()
      expect(s.memory.list().entries).toMatchObject([{ memoryId: explicit.memoryId, version: 2, authorization: 'explicit', sourceRefs: [...explicit.sourceRefs, s.source.messageId] }])
    } finally { await s.close() }
  })
  it('extracts from a real completed chat turn and rejects its late result after switching to temporary mode', async () => {
    const s = setup(), tasks = new R1TaskSupervisor(s.db, assets, () => s.memory.currentDeletionEpoch())
    const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>(), mode = { temporary: false }
    const foreground = createArkResponsesProvider({ env: { VOLCENGINE_ARK_API_KEY: 'synthetic', VOLCENGINE_ARK_MODEL: 'synthetic' }, fetch: async () =>
      new Response(JSON.stringify({ id: 'foreground-response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的，我们继续。' }] }] })) })
    try {
      const driver = new R1ConversationDriver(s.db, assets, tasks, foreground, () => s.persona.get(), [])
      registerChatHandlers({ handle(name, handler) { handlers.set(name, handler) } }, undefined, undefined, s.conversations, s.persona, assets, s.memory, mode,
        () => { s.automatic.invalidate(); s.manager.revokeAll() }, driver, undefined, s.manager, s.automatic)
      s.enabled()
      expect(await handlers.get('chat.sendMessage')!({ sender: { id: 7 } }, { text: '我喜欢无糖茶。' })).toMatchObject({ ok: true })
      const source = JSON.parse((s.requests[0].input as { content: string }[]).at(-1)!.content).at(-1)
      s.release({ ...empty, candidates: [{ ...s.candidate(), sourceTurnIds: [source.turnId] }] }); await s.automatic.whenIdle()
      const saved = s.memory.list().entries[0]
      expect(s.memory.sources(saved.memoryId)).toMatchObject([{ body: '我喜欢无糖茶。' }])
      expect(saved.sourceRefs).not.toContain(s.source.messageId)
      await handlers.get('chat.sendMessage')!({ sender: { id: 7 } }, { text: '我喜欢公园。' })
      const lateSource = JSON.parse((s.requests[1].input as { content: string }[]).at(-1)!.content).at(-1)
      expect(handlers.get('chat.setTemporary')!(null, { enabled: true })).toMatchObject({ ok: true })
      s.release({ ...empty, candidates: [{ ...s.candidate('喜欢公园'), sourceTurnIds: [lateSource.turnId] }] }); await s.automatic.whenIdle()
      await handlers.get('chat.sendMessage')!({ sender: { id: 7 } }, { text: '不能留下的临时内容。' })
      expect(s.requests).toHaveLength(2); expect(s.memory.list().entries).toHaveLength(1)
      expect(JSON.stringify(s.db.prepare('SELECT body FROM messages').all())).not.toContain('不能留下的临时内容')
    } finally { tasks.close(); await s.close() }
  })
  it('returns CAS conflicts through IPC and rejects caller-provided authority or extra fields', async () => {
    const s = setup(), revoked = vi.fn(), handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
    try {
      registerAutomaticMemoryHandlers(s.automatic, revoked, { handle(name, handler) { handlers.set(name, handler) } })
      const set = handlers.get('r1.memory.setPolicy')!
      expect(set(null, { enabled: true, expectedVersion: 1, authorize: true })).toMatchObject({ ok: false })
      expect(set(null, { enabled: true, expectedVersion: 1 })).toMatchObject({ ok: true, data: { enabled: true, version: 2 } })
      expect(set(null, { enabled: false, expectedVersion: 1 })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } })
      expect(revoked).toHaveBeenCalledOnce()
    } finally { await s.close() }
  })
})
