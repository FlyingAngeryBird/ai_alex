import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
import { registerTaskHandlers } from '../electron/main/ipc/taskHandlers'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1Artifacts } from '../electron/main/r1/artifacts'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import type { R1SessionMode } from '../electron/main/r1/sessionMode'
const assets = loadR1PromptAssets(resolve('r1-assets'))
describe('R1 task and artifact IPC session authority', () => {
  it('denies cross-session access and persistence without temporary save confirmation', () => {
    const db = openR1Database(':memory:')
    const conversation = new R1Conversations(db)
    const ordinarySession = conversation.start()
    const source = conversation.append({ sessionId: ordinarySession, turnId: 'ordinary-turn', role: 'user', body: '整理稿件', status: 'final' })
    const tempSession = conversation.start(true)
    const tempSource = conversation.append({ sessionId: tempSession, turnId: 'temp-turn', role: 'user', body: '临时稿件', status: 'final' })
    const tasks = new R1TaskSupervisor(db, assets, () => 0, { temporarySource: id => id === tempSource.messageId
      ? { ...tempSource, body: tempSource.body, temporary: true, timezone: 'Asia/Shanghai' } : undefined })
    const artifacts = new R1Artifacts(db)
    const input = { timezone: 'Asia/Shanghai', goal: '整理稿件', constraints: [], authorizedAliases: ['read_file'], complexity: 'light' as const }
    const ordinaryTask = tasks.accept({ ...input, requestKey: 'ordinary', sourceMessageId: source.messageId })
    const tempTask = tasks.accept({ ...input, requestKey: 'temporary', sourceMessageId: tempSource.messageId })
    const draft = { kind: 'text' as const, title: '工作稿', content: '稿件正文', baseArtifactId: null, baseArtifactVersion: null, sourceRefs: [] }
    const ordinaryArtifact = artifacts.create({ sourceTurnId: source.turnId, draft })
    const tempArtifact = artifacts.create({ sourceTurnId: tempSource.turnId, draft, temporaryOwner: tempSession })
    const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
    const mode: R1SessionMode = { temporary: false, sessionId: ordinarySession }
    registerTaskHandlers(tasks, artifacts, mode, { handle: (channel, handler) => { handlers.set(channel, handler) } })
    const call = (channel: string, input?: unknown) => handlers.get(channel)!({}, input)
    try {
      expect(call('r1.tasks.list')).toMatchObject({ ok: true, data: [{ taskId: ordinaryTask.taskId }] })
      expect(call('r1.tasks.get', { taskId: tempTask.taskId })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } })
      expect(call('r1.artifacts.get', { artifactId: tempArtifact.artifactId })).toMatchObject({ ok: false, error: { code: 'ARTIFACT_NOT_FOUND' } })
      mode.temporary = true; mode.sessionId = tempSession
      expect(call('r1.tasks.list')).toMatchObject({ ok: true, data: [{ taskId: tempTask.taskId }] })
      for (const method of ['get', 'pause', 'resume', 'cancel']) expect(call(`r1.tasks.${method}`, {
        taskId: ordinaryTask.taskId, expectedGoalVersion: 1 })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } })
      for (const method of ['get', 'revise', 'undo', 'save']) expect(call(`r1.artifacts.${method}`, {
        artifactId: ordinaryArtifact.artifactId, expectedVersion: 1, restoreVersion: 1, content: '新内容', actionId: 'cross-session'
      })).toMatchObject({ ok: false })
      const save = { artifactId: tempArtifact.artifactId, expectedVersion: 1, actionId: 'confirmed-save' }
      expect(call('r1.artifacts.save', save)).toMatchObject({ ok: false, error: { code: 'TEMPORARY_SAVE_CONFIRMATION_REQUIRED' } })
      expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()).toMatchObject({ n: 0 })
      expect(call('r1.artifacts.save', { ...save, temporarySaveConfirmed: true })).toMatchObject({ ok: true, data: { item: { body: '稿件正文' } } })
      tasks.endTemporary(tempSession); artifacts.endTemporary(tempSession); conversation.end(tempSession)
      expect(call('r1.tasks.get', { taskId: tempTask.taskId })).toMatchObject({ ok: false, error: { code: 'TASK_NOT_FOUND' } })
      expect(call('r1.artifacts.get', { artifactId: tempArtifact.artifactId })).toMatchObject({ ok: false })
      expect(db.prepare('SELECT COUNT(*) AS n FROM items').get()).toMatchObject({ n: 1 })
      mode.sessionId = null
      expect(call('r1.tasks.list')).toMatchObject({ ok: true, data: [] })
      expect(call('r1.tasks.get', { taskId: ordinaryTask.taskId })).toMatchObject({ ok: false })
      mode.temporary = false
      expect(call('r1.tasks.pause', { taskId: ordinaryTask.taskId, expectedGoalVersion: 0 })).toMatchObject({ ok: false, error: { code: 'INVALID_TASK_VERSION' } })
      expect(call('r1.tasks.pause', { taskId: ordinaryTask.taskId, expectedGoalVersion: 2 })).toMatchObject({ ok: false, error: { code: 'VERSION_CONFLICT' } })
      expect(call('r1.tasks.pause', { taskId: ordinaryTask.taskId, expectedGoalVersion: 1 })).toMatchObject({ ok: true, data: { status: 'paused' } })
    } finally { tasks.close(); db.close() }
  })
})
