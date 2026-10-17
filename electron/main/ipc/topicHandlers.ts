import { ipcMain } from 'electron'
import type { R1Database } from '../r1/database.js'
import { R1Topics } from '../r1/topics.js'
import type { R1SessionMode } from '../r1/sessionMode.js'
import type { TopicSummaryState } from '../r1/topicSummaries.js'
export function registerTopicHandlers(db: R1Database, mode: R1SessionMode, onInvalidated: (epoch: number) => void,
  summaryState: () => TopicSummaryState, onSelected: () => void, ipc: { handle(channel: string, handler: (event: unknown, payload?: unknown) => unknown): void } = ipcMain): void {
  const topics = new R1Topics(db)
  const normal = () => { if (mode.temporary) throw new Error('MEMORY_UNAVAILABLE_IN_TEMPORARY_SESSION') }
  const handle = (channel: string, keys: string[] | null, run: (input: Record<string, unknown>) => unknown) => ipc.handle(channel, (_event, payload) => {
    try {
      normal()
      if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload))) throw new Error('INVALID_TOPIC_PAYLOAD')
      const input = payload as Record<string, unknown> | undefined ?? {}
      if (keys && Object.keys(input).some(key => !keys.includes(key))) throw new Error('INVALID_TOPIC_PAYLOAD')
      return { ok: true, data: run(input) }
    } catch (error) { const code = error instanceof Error && /^[A-Z][A-Z0-9_:]{1,100}$/.test(error.message) ? error.message : 'TOPIC_FAILED'; return { ok: false, error: { code, message: code } } }
  })
  handle('r1.topics.list', ['query', 'page'], input => ({ ...topics.list(input), preparation: summaryState() }))
  handle('r1.topics.details', ['topicId'], input => ({ topic: topics.get(input.topicId as string), versions: topics.versions(input.topicId as string), sources: topics.sources(input.topicId as string), related: topics.related(input.topicId as string) }))
  handle('r1.topics.update', ['topicId', 'expectedVersion', 'title', 'summary', 'unresolved', 'status'], input => {
    const topic = topics.update(input as Parameters<R1Topics['update']>[0]); onInvalidated(topic.deletionEpoch); return topic
  })
  handle('r1.topics.forget', ['topicId', 'expectedVersion'], input => {
    const result = topics.forget(input as Parameters<R1Topics['forget']>[0]); onInvalidated(result.deletionEpoch); return result
  })
  handle('r1.topics.select', ['topicId', 'expectedVersion'], input => {
    const topic = topics.get(input.topicId as string)
    if (topic.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
    mode.selectedTopic = { topicId: topic.topicId, version: topic.version }; mode.selectedCandidate = null; mode.selectedArtifact = null
    onSelected(); return topic
  })
}
