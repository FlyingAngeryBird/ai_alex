import { ipcMain } from 'electron'
import type { R1Database } from '../r1/database.js'
import type { R1Conversations, SessionMessage } from '../r1/conversations.js'
import type { R1Artifacts, ArtifactRange } from '../r1/artifacts.js'
import type { R1SessionMode } from '../r1/sessionMode.js'
import { assertArtifactRange } from '../r1/artifactContext.js'

export function registerArtifactContextHandlers(db: R1Database, artifacts: R1Artifacts, conversations: R1Conversations,
  mode: R1SessionMode, onSelected: () => void, ipc: { handle(channel: string, handler: (event: unknown, input?: unknown) => unknown): void } = ipcMain) {
  const handle = (channel: string, keys: string[], run: (input: Record<string, unknown>) => unknown) => ipc.handle(channel, (_event, payload) => {
    try {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !keys.includes(key))) throw new Error('ARTIFACT_INPUT_INVALID')
      return { ok: true, data: run(payload as Record<string, unknown>) }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'ARTIFACT_OPERATION_FAILED'
      return { ok: false, error: { code, message: code } }
    }
  })
  const owner = () => mode.temporary ? mode.sessionId || '__missing__' : null
  handle('r1.artifacts.select', ['artifactId', 'expectedVersion', 'selection'], input => {
    if (input.artifactId === null && input.expectedVersion === null && input.selection === null) {
      const hadSelection = !!mode.selectedArtifact
      mode.selectedArtifact = null
      if (hadSelection) onSelected()
      return null
    }
    const artifact = artifacts.get(input.artifactId as string, owner())
    if (artifact.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
    const selection = input.selection as ArtifactRange | null
    if (selection !== null) {
      if (!selection || Object.keys(selection).some(key => !['start', 'end'].includes(key))) throw new Error('ARTIFACT_RANGE_INVALID')
      assertArtifactRange(artifact.content, selection)
    }
    const previous = JSON.stringify(mode.selectedArtifact)
    mode.selectedArtifact = { artifactId: artifact.artifactId, version: artifact.version, selection }
    mode.selectedCandidate = null; mode.selectedTopic = null
    if (previous !== JSON.stringify(mode.selectedArtifact)) onSelected()
    return artifact
  })
  handle('r1.artifacts.materials', ['artifactId'], input => {
    const artifact = artifacts.get(input.artifactId as string, owner())
    const eligible = (message: SessionMessage) => message.role === 'user' &&
      (message.turnId === artifact.sourceTurnId || artifact.sourceRefs.includes(message.messageId)) &&
      !db.prepare('SELECT 1 FROM source_suppression WHERE source_ref IN (?, ?)').get(message.messageId, message.turnId)
    if (mode.temporary) return conversations.messages(owner()!).filter(eligible)
    const ids = db.prepare(`SELECT DISTINCT m.session_id FROM messages m JOIN sessions s ON s.session_id=m.session_id
      WHERE s.temporary=0 AND s.status<>'memory_source' AND (m.turn_id=? OR m.message_id IN (SELECT value FROM json_each(?)))`)
      .all(artifact.sourceTurnId, JSON.stringify(artifact.sourceRefs)) as { session_id: string }[]
    return ids.flatMap(row => conversations.messages(row.session_id)).filter(eligible).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  })
}
