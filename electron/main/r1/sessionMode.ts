import type { R1TaskSupervisor } from './taskSupervisor.js'
export type R1SessionMode = { temporary: boolean; sessionId?: string | null; currentPlayingTrackKey?: string | null;
  selectedArtifact?: { artifactId: string; version: number; selection: import('./artifacts.js').ArtifactRange | null } | null;
  selectedTopic?: { topicId: string; version: number } | null;
  selectedCandidate?: { taskId: string; goalVersion: number; candidateId: string; candidateVersion: number } | null }
export function currentCandidateContext(mode: R1SessionMode | undefined, tasks?: R1TaskSupervisor) {
  const selected = mode?.selectedCandidate
  if (!selected || !tasks) return null
  try {
    const task = tasks.list(mode!.temporary ? mode!.sessionId || '__missing__' : null).find(task => task.taskId === selected.taskId)
    if (!task || task.goalVersion !== selected.goalVersion || !tasks.contextIsCurrent(task.taskId) ||
      tasks.candidateVersion(task.taskId, selected.candidateId) !== selected.candidateVersion) return null
    const candidate = task.webResult?.candidates.find(value => value.candidateId === selected.candidateId)
    const sources = task.webResult?.sources.filter(value => candidate?.sourceRefs.includes(value.sourceRef)) ?? []
    if (!candidate || !candidate.sourceRefs.length || candidate.sourceRefs.some(ref => !sources.some(value => value.sourceRef === ref))) return null
    return structuredClone({ ...selected, candidate, sources })
  } catch { return null }
}
export type CandidateContext = NonNullable<ReturnType<typeof currentCandidateContext>>
export function selectedConversationEntity(mode: R1SessionMode | undefined, tasks?: R1TaskSupervisor) {
  const selected = currentCandidateContext(mode, tasks)
  return selected ? { type: 'candidate' as const, id: selected.candidateId, version: selected.candidateVersion } : null
}
