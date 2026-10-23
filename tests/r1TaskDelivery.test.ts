import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { R1TaskDelivery } from '../electron/main/r1/taskDelivery'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import type { R1Task, TaskEvent } from '../electron/main/r1/taskSupervisor'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
const assets = loadR1PromptAssets(resolve('r1-assets'))
const cleanups: Array<() => void> = []
function fixtureWav(seconds = 1): ArrayBuffer {
  const bytes = seconds * 48000, wav = Buffer.alloc(bytes + 44)
  wav.write('RIFF'); wav.writeUInt32LE(bytes + 36, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24)
  wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(bytes, 40)
  return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer
}
const request = { taskId: 'task-fixture', goalVersion: 1, resultId: 'result-fixture', requestId: 'request-fixture' }
function fixture() {
  vi.stubEnv('VOLCENGINE_REALTIME_API_KEY', 'synthetic'); vi.stubEnv('VOLCENGINE_REALTIME_VOICE', 'voice')
  vi.stubEnv('VOLCENGINE_ARK_API_KEY', 'synthetic'); vi.stubEnv('VOLCENGINE_ARK_MODEL', 'model')
  const task: R1Task = { taskId: request.taskId, goalVersion: 1, resultId: request.resultId, status: 'partially_succeeded', temporary: false,
    goal: '整理两份资料', constraints: [], assetReleaseId: assets.releaseId, planVersion: 1, progressBrief: '已有部分结果',
    queuePosition: null, budget: assets.taskBudget('light'), runId: null,
    result: { resultId: request.resultId, goalVersion: 1, completionStatus: 'partial', replyBrief: '已找到一份资料，另一份尚未核实。',
      sourceRefs: ['source-fixture'], artifacts: [], entityReceipts: [], unresolved: ['另一份资料'], candidateRefs: [] } }
  const preferences = { version: 1, doNotDisturb: false, proactiveSpeechEnabled: true, inputDeviceId: null, outputDeviceId: null, reducedMotion: false }
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db)
  const scope = { temporary: false, sessionId: conversations.start() }, persona = { assistantName: 'Seamo AI', userAddress: '海', style: '简洁', voiceId: 'voice', version: 1 }
  const provider = { request: vi.fn(async (input: any) => {
    const prepared = input.boundary.finalize([{ role: 'system', content: 'untrusted upstream' }])
    expect(prepared.tools).toEqual([]); expect(input.boundary.systemText).not.toContain('untrusted upstream')
    expect(input.boundary.systemText).toContain('"assistantName":"Seamo AI"')
    expect(input.boundary.systemText).toContain('"completionStatus":"partial"')
    expect(() => input.boundary.validateToolCall('web_search', {})).toThrow('TASK_DELIVERY_TOOLS_FORBIDDEN')
    return { id: 'synthetic', text: '已找到一份资料，另一份还未核实。', output: [], calls: [], usage: null }
  }) }
  const synthesize = vi.fn(async (input: any) => { input.boundary.assertCurrent(); expect(input.boundary.diagnostic.toolAliases).toEqual([]); return fixtureWav() })
  const current = { valid: true, revision: 1 }
  const tasks = { list: vi.fn(() => [task]), contextIsCurrent: () => current.valid }
  const service = new R1TaskDelivery({ assets, tasks, conversations, provider, persona: () => persona, preferences: () => preferences,
    scope: () => ({ ...scope }), configurationRevision: () => current.revision, synthesize })
  const event = () => ({ eventId: 'event', occurredAt: '2026-10-17T10:00:00Z', reason: 'completed', task } as TaskEvent)
  cleanups.push(() => { service.invalidate(); db.close() })
  return { service, provider, synthesize, task, preferences, persona, scope, current, event, db, conversations }
}
afterEach(() => { while (cleanups.length) cleanups.pop()!(); vi.unstubAllEnvs() })
it('uses PR01/PR02/PR07 with zero tools only for a new, authoritative result and deduplicates repeats', async () => {
  const f = fixture(); expect(await f.service.prepare(7, request)).toBeNull(); expect(f.provider.request).not.toHaveBeenCalled()
  f.service.observe(f.event()); const result = await f.service.prepare(7, request)
  expect(result?.mimeType).toBe('audio/wav'); expect(f.provider.request).toHaveBeenCalledTimes(1); expect(f.synthesize).toHaveBeenCalledTimes(1)
  f.service.observe(f.event()); expect(await f.service.prepare(7, request)).toBeNull()
})
it('keeps generated speech outside heard context until the exact device completion receipt arrives', async () => {
  const f = fixture(); f.service.observe(f.event()); const audio = await f.service.prepare(7, request)
  expect(f.conversations.messages(f.scope.sessionId)[0]).toMatchObject({ status: 'generated', playedUntilMs: 0, responseId: audio!.responseId })
  expect(f.conversations.modelTurns(f.scope.sessionId)[0].text).toBe('')
  expect(() => f.service.reportPlayback(7, { requestId: request.requestId, status: 'completed', playedUntilMs: 1000 })).toThrow('TASK_DELIVERY_PLAYBACK_NOT_STARTED')
  expect(() => f.service.reportPlayback(8, { requestId: request.requestId, status: 'started', playedUntilMs: 0 })).toThrow('TASK_DELIVERY_OWNER_MISMATCH')
  f.service.reportPlayback(7, { requestId: request.requestId, status: 'started', playedUntilMs: 0 })
  expect(() => f.service.reportPlayback(7, { requestId: request.requestId, status: 'completed', playedUntilMs: 500 })).toThrow('INVALID_PLAYBACK_COMPLETION')
  f.service.reportPlayback(7, { requestId: request.requestId, status: 'completed', playedUntilMs: 1000 })
  expect(f.conversations.messages(f.scope.sessionId)[0]).toMatchObject({ status: 'heard', playedUntilMs: 1000 })
  expect(f.conversations.modelTurns(f.scope.sessionId)[0].heardText).toBe(audio!.text)
})
it('records interruption progress and rejects a late completion after cancellation', async () => {
  const f = fixture(); f.service.observe(f.event()); await f.service.prepare(7, request)
  f.service.reportPlayback(7, { requestId: request.requestId, status: 'started', playedUntilMs: 0 })
  f.service.reportPlayback(7, { requestId: request.requestId, status: 'interrupted', playedUntilMs: 420 })
  f.service.reportPlayback(7, { requestId: request.requestId, status: 'completed', playedUntilMs: 1000 })
  expect(f.conversations.messages(f.scope.sessionId)[0]).toMatchObject({ status: 'interrupted', playedUntilMs: 420 })
  expect(f.conversations.modelTurns(f.scope.sessionId)[0].text).toBe('')
})
it('tracks a complete 20-second utterance in bounded ledger frames', async () => {
  const f = fixture(); f.synthesize.mockResolvedValueOnce(fixtureWav(20)); f.service.observe(f.event())
  await f.service.prepare(7, request)
  f.service.reportPlayback(7, { requestId: request.requestId, status: 'started', playedUntilMs: 0 })
  f.service.reportPlayback(7, { requestId: request.requestId, status: 'completed', playedUntilMs: 20000 })
  expect(f.conversations.messages(f.scope.sessionId)[0]).toMatchObject({ status: 'heard', playedUntilMs: 20000 })
})
it('keeps temporary delivery text and playback metadata in memory and revokes it on scope change', async () => {
  const f = fixture(); f.scope.temporary = true; f.scope.sessionId = f.conversations.start(true)
  f.service.observe(f.event()); await f.service.prepare(7, request)
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toMatchObject({ n: 0 })
  f.service.reportPlayback(7, { requestId: request.requestId, status: 'started', playedUntilMs: 0 })
  f.service.reportPlayback(7, { requestId: request.requestId, status: 'playing', playedUntilMs: 250 })
  const sessionId = f.scope.sessionId; f.scope.sessionId = f.conversations.start()
  f.service.reportPlayback(7, { requestId: request.requestId, status: 'completed', playedUntilMs: 1000 })
  expect(f.conversations.messages(sessionId)[0]).toMatchObject({ status: 'interrupted', playedUntilMs: 250 })
})
it('does not generate a brief for DND or disabled proactive speech, including after unmuting', async () => {
  const f = fixture(); f.preferences.doNotDisturb = true; f.service.observe(f.event())
  expect(await f.service.prepare(7, request)).toBeNull(); f.preferences.doNotDisturb = false
  expect(await f.service.prepare(7, request)).toBeNull(); expect(f.provider.request).not.toHaveBeenCalled()
})
it('rejects old goals, cancelled tasks and revoked source context before model access', async () => {
  const f = fixture(); f.service.observe(f.event()); f.task.goalVersion = 2
  await expect(f.service.prepare(7, request)).rejects.toThrow('TASK_DELIVERY_STALE')
  f.task.goalVersion = 1; f.task.status = 'cancelled'; await expect(f.service.prepare(7, request)).rejects.toThrow('TASK_DELIVERY_STALE')
  f.task.status = 'partially_succeeded'; f.current.valid = false
  await expect(f.service.prepare(7, request)).rejects.toThrow('TASK_DELIVERY_STALE'); expect(f.provider.request).not.toHaveBeenCalled()
})
it('cancels only the owning request and suppresses late model output before TTS', async () => {
  const f = fixture(); let finish!: (value: any) => void
  f.provider.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  f.service.observe(f.event()); const pending = f.service.prepare(7, request)
  f.service.cancel(8, request.requestId); f.service.cancel(7, 'other-request'); expect(f.synthesize).not.toHaveBeenCalled()
  f.service.cancel(7, request.requestId); finish({ text: '旧简报' })
  await expect(pending).rejects.toThrow('TASK_DELIVERY_REVOKED'); expect(f.synthesize).not.toHaveBeenCalled()
  f.service.observe(f.event()); expect(await f.service.prepare(7, request)).toBeNull()
})
it.each(['scope', 'persona', 'configuration', 'preferences', 'memory'])('revokes pending synthesis on %s changes', async kind => {
  const f = fixture(); let finish!: (value: ArrayBuffer) => void
  f.synthesize.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  f.service.observe(f.event()); const pending = f.service.prepare(7, request)
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  if (kind === 'scope') f.scope.temporary = true
  if (kind === 'persona') f.persona.version++
  if (kind === 'configuration') f.current.revision++
  if (kind === 'preferences') f.preferences.version++
  if (kind === 'memory') f.service.invalidate()
  finish(new ArrayBuffer(4)); await expect(pending).rejects.toThrow('TASK_DELIVERY_REVOKED')
})
