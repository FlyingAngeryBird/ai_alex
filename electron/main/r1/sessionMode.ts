import type { R1TaskSupervisor } from './taskSupervisor.js'
export type R1SessionMode = { temporary: boolean; sessionId?: string | null;
  selectedCandidate?: { taskId: string; goalVersion: number; candidateId: string; candidateVersion: number } | null }
export function selectedConversationEntity(mode: R1SessionMode | undefined, tasks?: R1TaskSupervisor) {
  const selected = mode?.selectedCandidate
  if (!selected || !tasks) return null
  try {
    const task = tasks.list(mode!.temporary ? mode!.sessionId || '__missing__' : null).find(task => task.taskId === selected.taskId)
    if (!task || task.goalVersion !== selected.goalVersion || !tasks.contextIsCurrent(task.taskId) ||
      tasks.candidateVersion(task.taskId, selected.candidateId) !== selected.candidateVersion) return null
    return { type: 'candidate' as const, id: selected.candidateId, version: selected.candidateVersion }
  } catch { return null }
}
