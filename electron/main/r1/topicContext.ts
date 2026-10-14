import type { R1Database } from './database.js'
import { R1Topics, topicContext } from './topics.js'
import type { R1SessionMode } from './sessionMode.js'
export function topicConversationContext(db: R1Database, mode?: R1SessionMode) {
  if (mode?.temporary) return { topics: [], selected: null }
  const topics = new R1Topics(db), selected = mode?.selectedTopic
  if (selected) {
    try {
      const current = topics.get(selected.topicId)
      if (current.version !== selected.version) throw new Error('VERSION_CONFLICT')
      return { topics: [topicContext(current)], selected: { type: 'topic' as const, id: current.topicId, version: current.version } }
    } catch { mode!.selectedTopic = null }
  }
  return { topics: topics.list().entries.slice(0, 5).map(topicContext), selected: null }
}
