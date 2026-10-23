import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1Artifacts } from '../electron/main/r1/artifacts'
import { artifactParagraph, bindArtifactEdit, currentArtifactContext } from '../electron/main/r1/artifactContext'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1TaskToolExecutor } from '../electron/main/r1/taskToolExecutor'
import { R1ConversationTools } from '../electron/main/r1/conversationTools'
import { R1TaskRunner } from '../electron/main/r1/taskRunner'
import type { ArkResponse } from '../electron/main/providers/arkResponsesProvider'
import { R1PersonaStore } from '../electron/main/r1/persona'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { registerArtifactContextHandlers } from '../electron/main/ipc/artifactContextHandlers'
import type { R1SessionMode } from '../electron/main/r1/sessionMode'
vi.mock('electron', () => ({ ipcMain: { handle() {} } }))
const assets = loadR1PromptAssets(resolve('r1-assets'))
const original = '第一段🙂：先完成桌面验收。\n\n第二段：先验证中文输入，再验证导出、冲突处理和数据回退，所有结果均要记录。\n\n第三段：暂不发布移动版。'
function fixture(temporary = false) {
  const db = openR1Database(':memory:'), conversations = new R1Conversations(db), artifacts = new R1Artifacts(db)
  const mode: R1SessionMode = { temporary, sessionId: conversations.start(temporary) }
  const initial = conversations.append({ sessionId: mode.sessionId!, turnId: 'initial', role: 'user', body: original, status: 'final' })
  const artifact = artifacts.create({ sourceTurnId: initial.turnId, temporaryOwner: temporary ? mode.sessionId : null,
    draft: { kind: 'text', title: '验收计划', content: original, baseArtifactId: null, baseArtifactVersion: null, sourceRefs: [initial.messageId] } })
  mode.selectedArtifact = { artifactId: artifact.artifactId, version: 1, selection: null }
  const source = conversations.append({ sessionId: mode.sessionId!, turnId: 'revision', role: 'user', body: '第二段短一些，其他内容不变。', status: 'final' })
  const tasks = new R1TaskSupervisor(db, assets, () => 0, { artifacts, temporarySource: id => temporary && id === source.messageId ? { ...source, temporary, timezone: 'Asia/Shanghai' } : undefined })
  const observed = currentArtifactContext(mode, artifacts)!
  const binding = bindArtifactEdit(observed, { artifactId: artifact.artifactId, expectedVersion: 1, scope: 'paragraph', paragraphIndex: 2 }, artifacts, temporary ? mode.sessionId! : null)
  const accept = () => tasks.accept({ requestKey: 'edit', sourceMessageId: source.messageId, timezone: 'Asia/Shanghai', goal: source.body,
    constraints: [], authorizedAliases: ['read_file', 'write_todos'], complexity: 'light', artifactEdit: binding })
  const draft = (content = original.replace('先验证中文输入，再验证导出、冲突处理和数据回退，所有结果均要记录。', '验证输入、导出与回退。')) => ({ status: 'completed', goalVersion: 1,
    replyBrief: '已缩短第二段。', sourceRefs: [source.messageId], receiptActionIds: [], candidates: [], unresolved: [], artifacts: [{ kind: 'text', title: artifact.title, content,
      baseArtifactId: artifact.artifactId, baseArtifactVersion: 1, sourceRefs: [source.messageId] }] })
  return { db, conversations, artifacts, artifact, mode, source, tasks, observed, binding, accept, draft, close() { tasks.close(); db.close() } }
}
describe('current Artifact continuation', () => {
  it.each([false, true])('passes the actual version through readonly task material and publishes the same object (temporary=%s)', temporary => {
    const s = fixture(temporary)
    try {
      const tools = new R1ConversationTools(s.db, assets, s.tasks, { source: s.source, temporary, timezone: 'Asia/Shanghai', persistenceConfirmed: false,
        selectedArtifact: s.observed, assertCurrent() {} }, ['read_file', 'write_todos'], undefined, s.artifacts)
      const accepted = tools.execute('start_task', { goal: s.source.body, constraints: [], sourceRefs: [s.source.turnId],
        artifactTarget: { artifactId: s.artifact.artifactId, expectedVersion: 1, scope: 'paragraph', paragraphIndex: 2 } }, 'edit-call')
      expect(accepted).toMatchObject({ status: 'accepted' })
      const lease = s.tasks.claimNext()!.lease, executor = new R1TaskToolExecutor(s.tasks, assets)
      const observation = s.tasks.beginDecision(lease).observations.find(row => row.kind === 'artifact')!
      const receipt = executor.execute(lease, 'read_file', { file_path: observation.resourcePath }, 'read-current')
      expect(JSON.parse(String(receipt.data.content))).toEqual(s.binding)
      const result = s.tasks.publish(lease, s.draft(), s.artifacts)
      expect(result.artifacts).toMatchObject([{ artifactId: s.artifact.artifactId, version: 2 }])
      const current = s.artifacts.get(s.artifact.artifactId, temporary ? s.mode.sessionId! : null)
      expect(current.content).toBe(s.draft().artifacts[0].content)
      expect(current.sourceRefs).toEqual([s.artifact.sourceRefs[0], s.source.messageId])
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toMatchObject({ n: temporary ? 0 : 1 })
      if (temporary) {
        expect(s.db.prepare('SELECT COUNT(*) AS n FROM agent_tasks').get()).toMatchObject({ n: 0 })
        expect(s.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toMatchObject({ n: 0 })
      }
    } finally { s.close() }
  })
  it.each(['outside', 'title', 'new-object', 'no-object'] as const)('rejects %s without changing the draft', reason => {
    const s = fixture()
    try {
      s.accept(); const lease = s.tasks.claimNext()!.lease, value = s.draft()
      if (reason === 'outside') value.artifacts[0].content = value.artifacts[0].content.replace('第一段🙂', '改掉第一段')
      if (reason === 'title') value.artifacts[0].title = '擅改标题'
      if (reason === 'new-object') Object.assign(value.artifacts[0], { baseArtifactId: null, baseArtifactVersion: null })
      if (reason === 'no-object') value.artifacts = []
      expect(() => s.tasks.publish(lease, value, s.artifacts)).toThrow()
      expect(s.artifacts.get(s.artifact.artifactId)).toMatchObject({ version: 1, content: original })
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get()).toMatchObject({ n: 1 })
      expect(s.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE status='succeeded'").get()).toMatchObject({ n: 0 })
    } finally { s.close() }
  })
  it('preserves newer manual edits and refuses an old task read or publication', () => {
    const s = fixture()
    try {
      s.accept(); const lease = s.tasks.claimNext()!.lease
      s.artifacts.revise({ artifactId: s.artifact.artifactId, expectedVersion: 1, content: '用户已经手改' })
      expect(() => s.tasks.artifactInput(lease)).toThrow('VERSION_CONFLICT')
      expect(() => s.tasks.publish(lease, s.draft(), s.artifacts)).toThrow('VERSION_CONFLICT')
      expect(s.artifacts.get(s.artifact.artifactId)).toMatchObject({ version: 2, content: '用户已经手改' })
    } finally { s.close() }
  })
  it('settles an in-flight model conflict and allows an explicitly revised goal to use the new baseline', async () => {
    const s = fixture(); let release!: (value: ArkResponse) => void
    const request = vi.fn(() => new Promise<ArkResponse>(resolve => { release = resolve }))
    const runner = new R1TaskRunner(s.tasks, assets, new R1TaskToolExecutor(s.tasks, assets), s.artifacts, { request }, () => new R1PersonaStore(s.db).get())
    try {
      const accepted = s.accept(); runner.start()
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
      s.artifacts.revise({ artifactId: s.artifact.artifactId, expectedVersion: 1, content: '手改第一段🙂\n\n最新第二段\n\n保持第三段' })
      release({ id: 'late', text: JSON.stringify(s.draft()), calls: [], output: [], usage: null })
      await runner.idle(); await runner.close()
      expect(s.tasks.get(accepted.taskId)).toMatchObject({ status: 'partially_succeeded', result: { unresolved: ['VERSION_CONFLICT'] } })
      expect(s.artifacts.get(s.artifact.artifactId)).toMatchObject({ version: 2, content: '手改第一段🙂\n\n最新第二段\n\n保持第三段' })
      s.mode.selectedArtifact!.version = 2
      const binding = bindArtifactEdit(currentArtifactContext(s.mode, s.artifacts), { artifactId: s.artifact.artifactId, expectedVersion: 2, scope: 'paragraph', paragraphIndex: 2 }, s.artifacts, null)
      s.tasks.steer({ taskId: accepted.taskId, expectedGoalVersion: 1, sourceMessageId: s.source.messageId, goal: '以最新第二段继续', constraints: [], artifactEdit: binding })
      const lease = s.tasks.claimNext()!.lease
      expect(s.tasks.artifactInput(lease)).toMatchObject({ artifact: { version: 2 }, target: artifactParagraph(binding.artifact.content, 2) })
    } finally { s.tasks.close(); await runner.close(); s.db.close() }
  })
  it.each([true, false])('repairs an out-of-range proposal once using actual source material, repaired=%s', async repaired => {
    const s = fixture(); let calls = 0
    const invalid = s.draft().artifacts[0].content.replace('第一段🙂', '擅改第一段')
    const request = vi.fn(async (input: Parameters<ConstructorParameters<typeof R1TaskRunner>[4]['request']>[0]): Promise<ArkResponse> => {
      calls++
      if (calls === 2) {
        expect(input.boundary.finalize(input.messages).tools).toEqual([])
        expect(input.boundary.systemText).toContain('第一段🙂')
        expect(input.boundary.systemText).toContain('ARTIFACT_OUTSIDE_TARGET_CHANGED')
      }
      return { id: `response-${calls}`, text: JSON.stringify(s.draft(calls === 2 && repaired ? undefined : invalid)), calls: [], output: [], usage: null }
    })
    const runner = new R1TaskRunner(s.tasks, assets, new R1TaskToolExecutor(s.tasks, assets), s.artifacts, { request }, () => new R1PersonaStore(s.db).get())
    try {
      const accepted = s.accept(); runner.start(); await runner.idle()
      expect(request).toHaveBeenCalledTimes(2)
      expect(s.artifacts.get(s.artifact.artifactId).version).toBe(repaired ? 2 : 1)
      expect(s.tasks.get(accepted.taskId).status).toBe(repaired ? 'succeeded' : 'failed')
    } finally { s.tasks.close(); await runner.close(); s.db.close() }
  })
  it('rejects invented targets and expansions of an actual user selection', () => {
    const s = fixture()
    try {
      const proposal = { artifactId: s.artifact.artifactId, expectedVersion: 1, scope: 'whole' as const, paragraphIndex: null }
      expect(() => bindArtifactEdit(s.observed, { ...proposal, artifactId: 'invented' }, s.artifacts, null)).toThrow('ARTIFACT_TARGET_NOT_OBSERVED')
      expect(() => bindArtifactEdit({ ...s.observed, selection: s.binding.target }, proposal, s.artifacts, null)).toThrow('ARTIFACT_OUTSIDE_TARGET_CHANGED')
      expect(bindArtifactEdit({ ...s.observed, selection: s.binding.target }, { ...proposal, scope: 'selection' }, s.artifacts, null)).toEqual(s.binding)
    } finally { s.close() }
  })
  it('uses Unicode codepoints, CRLF and blank-line paragraph boundaries without silently truncating material', () => {
    expect(artifactParagraph('第一🙂\r\n继续第一段\r\n \r\n第二段', 2)).toEqual({ start: [...'第一🙂\r\n继续第一段\r\n \r\n'].length, end: [...'第一🙂\r\n继续第一段\r\n \r\n第二段'].length })
    expect(() => artifactParagraph(original, 99)).toThrow('ARTIFACT_PARAGRAPH_INVALID')
    const s = fixture()
    try { expect(() => s.artifacts.revise({ artifactId: s.artifact.artifactId, expectedVersion: 1, content: '🙂'.repeat(8001) })).toThrow('ARTIFACT_CONTENT_INVALID') }
    finally { s.close() }
  })
  it('enforces selection versions and source visibility through IPC', () => {
    const s = fixture(), handlers = new Map<string, (_event: unknown, input?: unknown) => unknown>(), selected = vi.fn()
    try {
      registerArtifactContextHandlers(s.db, s.artifacts, s.conversations, s.mode, selected, { handle(name, handler) { handlers.set(name, handler) } })
      const call = (name: string, input: unknown) => handlers.get(name)!({}, input)
      expect(call('r1.artifacts.materials', { artifactId: s.artifact.artifactId })).toMatchObject({ ok: true, data: [{ body: original }] })
      expect(call('r1.artifacts.select', { artifactId: s.artifact.artifactId, expectedVersion: 1, selection: s.binding.target })).toMatchObject({ ok: true })
      expect(selected).toHaveBeenCalledOnce()
      expect(call('r1.artifacts.select', { artifactId: null, expectedVersion: null, selection: null })).toEqual({ ok: true, data: null })
      expect(s.mode.selectedArtifact).toBeNull()
      expect(call('r1.artifacts.select', { artifactId: s.artifact.artifactId, expectedVersion: 0, selection: null })).toMatchObject({ ok: false })
      s.mode.temporary = true; s.mode.sessionId = s.conversations.start(true)
      expect(call('r1.artifacts.materials', { artifactId: s.artifact.artifactId })).toMatchObject({ ok: false })
      expect(call('r1.artifacts.select', { artifactId: s.artifact.artifactId, expectedVersion: 1, selection: null })).toMatchObject({ ok: false })
    } finally { s.close() }
  })
})
