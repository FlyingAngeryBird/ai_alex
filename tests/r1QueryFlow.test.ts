import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { openR1Database } from '../electron/main/r1/database'
import { R1Conversations } from '../electron/main/r1/conversations'
import { R1Items } from '../electron/main/r1/items'
import { R1Artifacts } from '../electron/main/r1/artifacts'
import { R1TaskSupervisor } from '../electron/main/r1/taskSupervisor'
import { R1TaskToolExecutor } from '../electron/main/r1/taskToolExecutor'
import { R1TaskRunner } from '../electron/main/r1/taskRunner'
import { R1ConversationDriver } from '../electron/main/r1/conversationDriver'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import { R1PersonaStore } from '../electron/main/r1/persona'
import { currentCandidateContext } from '../electron/main/r1/sessionMode'

const assets = loadR1PromptAssets(resolve('r1-assets'))
const persona = () => ({ version: 1, assistantName: 'Seamo AI', userAddress: '', style: '自然简洁', voiceId: '' })
const response = (id: string, output: unknown[]) => {
  const calls = output.filter((item): item is { type: 'function_call'; call_id: string; name: string; arguments: string } =>
    Boolean(item) && (item as { type?: string }).type === 'function_call')
  return { id, output, calls, text: output.filter(item => (item as { type?: string }).type === 'message')
    .flatMap(item => (item as { content: Array<{ text: string }> }).content.map(part => part.text)).join('\n'), usage: null }
}
const call = (id: string, name: string, args: Record<string, unknown>) =>
  ({ type: 'function_call', id, call_id: id, name, arguments: JSON.stringify(args) })
const message = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })

it('completes a query from cited search evidence, then saves the selected second candidate and a linked reminder', async () => {
  const db = openR1Database(':memory:')
  const conversations = new R1Conversations(db)
  const items = new R1Items(db)
  const artifacts = new R1Artifacts(db)
  const tasks = new R1TaskSupervisor(db, assets, () => 0)
  const sessionId = conversations.start()
  const now = new Date().toISOString()
  const searchCandidates = [
    { candidateId: 'c1', title: 'RFC 9110 HTML', url: 'https://www.rfc-editor.org/rfc/rfc9110.html',
      snippet: 'HTML rendering of the HTTP Semantics specification.', query: 'RFC 9110', queriedAtUtc: now,
      pageDate: '2022-06-01', readDepth: 'search_summary' as const },
    { candidateId: 'c2', title: 'RFC 9110 text', url: 'https://www.rfc-editor.org/rfc/rfc9110.txt',
      snippet: 'Plain-text version of RFC 9110, the current HTTP Semantics specification.', query: 'RFC 9110',
      queriedAtUtc: now, pageDate: '2022-06-01', readDepth: 'search_summary' as const },
    { candidateId: 'c3', title: 'RFC 9112', url: 'https://www.rfc-editor.org/rfc/rfc9112.html',
      snippet: 'HTTP/1.1 message syntax, companion to RFC 9110.', query: 'RFC 9110', queriedAtUtc: now,
      pageDate: '2022-06-01', readDepth: 'search_summary' as const }
  ]
  const search = { async search() { return { query: 'RFC 9110', queriedAtUtc: now, moreResultsAvailable: false, candidates: searchCandidates } } }
  const source = conversations.append({ sessionId, turnId: 'turn-query', role: 'user', status: 'final',
    body: '查一下 RFC 9110 官方标准页，给我候选来源。' })
  const task = tasks.accept({ requestKey: 'query-flow', sourceMessageId: source.messageId, timezone: 'Asia/Shanghai',
    goal: source.body, constraints: [], complexity: 'complex', authorizedAliases: ['read_file', 'web_search', 'web_read_page'] })
  let searchActionId = ''
  const taskProvider = { async request(input: { rounds?: Array<{ results: Array<{ output: unknown }> }> }) {
    const rounds = input.rounds ?? []
    if (rounds.length === 0) return response('t1', [call('t1', 'read_file', { file_path: '/skills/web-qa/SKILL.md' })])
    if (rounds.length === 1) return response('t2', [call('t2', 'web_search', { query: 'RFC 9110' })])
    const receipt = rounds[rounds.length - 1].results[0].output as { actionId: string }
    searchActionId = receipt.actionId
    const draft = { status: 'completed', goalVersion: 1, replyBrief: '找到 RFC 9110 官方标准页（仅搜索摘要，未读全文）。',
      sourceRefs: ['source:c2'], receiptActionIds: [searchActionId], artifacts: [], unresolved: [],
      candidates: [{ candidateId: 'c2', label: 'RFC 9110 text',
        summary: 'Plain-text version of RFC 9110, the current HTTP Semantics specification.', sourceRefs: ['source:c2'] }] }
    return response('t3', [message(JSON.stringify(draft))])
  } } as unknown as ReturnType<typeof import('../electron/main/providers/arkResponsesProvider').createArkResponsesProvider>
  const runner = new R1TaskRunner(tasks, assets, new R1TaskToolExecutor(tasks, assets, undefined, search),
    artifacts, taskProvider, persona)
  try {
    runner.start()
    await runner.idle()
    const finished = tasks.get(task.taskId)
    expect(finished).toMatchObject({ status: 'succeeded' })
    expect(finished.result).toMatchObject({ completionStatus: 'completed', sourceRefs: ['source:c2'] })
    expect(finished.webResult?.candidates.map(candidate => candidate.candidateId)).toEqual(['c1', 'c2', 'c3'])
    expect(finished.webResult?.sources.every(source => source.readStatus === 'not_read')).toBe(true)
    expect(finished.result?.entityReceipts).toContainEqual(expect.objectContaining({ tool: 'web.search', status: 'succeeded' }))

    // Page selection uses the same versioned identity path as r1.tasks.selectCandidate.
    const candidateVersion = tasks.candidateVersion(task.taskId, 'c2')
    const mode = { temporary: false, sessionId, selectedCandidate: { taskId: task.taskId,
      goalVersion: finished.goalVersion, candidateId: 'c2', candidateVersion } }
    const currentCandidate = currentCandidateContext(mode, tasks)
    expect(currentCandidate).toMatchObject({ candidate: { candidateId: 'c2' }, goalVersion: finished.goalVersion })
    expect(currentCandidate?.sources.map(item => item.url)).toContain('https://www.rfc-editor.org/rfc/rfc9110.txt')

    // A natural follow-up turn sees the selected candidate in its system context.
    const followUp = conversations.append({ sessionId, turnId: 'turn-follow-up', role: 'user', status: 'final',
      body: '第二个的来源可靠吗？把刚才选中的官方标准记下来，并1小时后提醒我读它。' })
    const prompts: string[] = []
    const candidateTarget = { taskId: task.taskId, goalVersion: finished.goalVersion, candidateId: 'c2', candidateVersion }
    const dueAt = new Date(Date.parse(followUp.createdAt) + 3600_000).toISOString()
    const conversationProvider = { async request(input: { boundary: { systemText: string }; rounds?: Array<{ results: Array<{ output: unknown }> }> }) {
      prompts.push(input.boundary.systemText)
      const rounds = input.rounds ?? []
      if (rounds.length === 0) return response('m1', [call('m1', 'load_skill', { skillId: 'SK03' })])
      if (rounds.length === 1) return response('m2', [call('m2', 'notes_create', { type: 'note', mode: 'original',
        title: 'RFC 9110 官方标准', content: '候选原文由程序绑定，不使用此字段替换。', sourceRefs: [followUp.messageId],
        candidateTarget })])
      if (rounds.length === 2) return response('m3', [call('m3', 'load_skill', { skillId: 'SK04' })])
      if (rounds.length === 3) {
        const itemId = (rounds[1].results[0].output as { entityId: string }).entityId
        return response('m4', [call('m4', 'reminders_create', { content: '阅读 RFC 9110 官方标准', dueAt,
          timezone: 'Asia/Shanghai', kind: 'reminder', itemId, sourceRefs: [followUp.turnId], linkPurpose: 'independent' })])
      }
      return response('m5', [message('已经记下这个官方标准，并安排了一小时后的提醒。')])
    } } as unknown as ReturnType<typeof import('../electron/main/providers/arkResponsesProvider').createArkResponsesProvider>
    const driver = new R1ConversationDriver(db, assets, tasks, conversationProvider, persona,
      ['read_file', 'web_search', 'web_read_page'], undefined, artifacts)
    const scope = { source: followUp, temporary: false, timezone: 'Asia/Shanghai', persistenceConfirmed: false,
      selectedCandidate: currentCandidate, assertCurrent() {} }
    await driver.reply({ scope, messages: [{ role: 'user', content: followUp.body }], context: {
      sessionId, sessionGeneration: 1, turnId: followUp.turnId, currentTime: followUp.createdAt, timezone: 'Asia/Shanghai',
      temporary: false, contextVersion: 1, personaVersion: 1, deletionEpoch: 0, selectedEntity: null,
      currentCandidate, availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: [], memories: [], topics: [], activeTasks: [] } })
    expect(prompts[0]).toContain('RFC 9110 text')
    const saved = items.list()
    expect(saved).toHaveLength(1)
    expect(saved[0].title).toBe('RFC 9110 官方标准')
    const view = items.toolView(saved[0].itemId)
    expect(view.sourceRefs).toEqual(['source:c2'])
    const reminders = items.listReminders()
    expect(reminders).toHaveLength(1)
    expect(reminders[0]).toMatchObject({ itemId: saved[0].itemId, dueAtUtc: dueAt, linkPurpose: 'independent' })

    // Repeating the same candidate save keeps the same Item identity.
    const duplicateSource = conversations.append({ sessionId, turnId: 'turn-duplicate', role: 'user', status: 'final',
      body: '把刚才选中的官方标准再记一次，不要新建副本。' })
    const duplicateProvider = { async request(input: { rounds?: Array<{ results: Array<{ output: unknown }> }> }) {
      const rounds = input.rounds ?? []
      if (rounds.length === 0) return response('d1', [call('d1', 'load_skill', { skillId: 'SK03' })])
      if (rounds.length === 1) return response('d2', [call('d2', 'notes_create', { type: 'note', mode: 'original',
        title: '重复保存', content: '不使用', sourceRefs: [duplicateSource.messageId], candidateTarget })])
      return response('d3', [message('沿用了同一条记录。')])
    } } as unknown as ReturnType<typeof import('../electron/main/providers/arkResponsesProvider').createArkResponsesProvider>
    const duplicateDriver = new R1ConversationDriver(db, assets, tasks, duplicateProvider, persona,
      ['read_file', 'web_search', 'web_read_page'], undefined, artifacts)
    await duplicateDriver.reply({ scope: { ...scope, source: duplicateSource }, messages: [{ role: 'user', content: duplicateSource.body }],
      context: { sessionId, sessionGeneration: 1, turnId: duplicateSource.turnId, currentTime: duplicateSource.createdAt,
        timezone: 'Asia/Shanghai', temporary: false, contextVersion: 1, personaVersion: 1, deletionEpoch: 0,
        selectedEntity: null, currentCandidate, availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: [],
        memories: [], topics: [], activeTasks: [] } })
    expect(items.list()).toHaveLength(1)
    expect(items.list()[0].itemId).toBe(saved[0].itemId)
    expect(items.listReminders()).toHaveLength(1)
  } finally { tasks.close(); await runner.close(); db.close() }
})
