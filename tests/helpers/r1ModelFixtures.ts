export function modelContext(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'test-session', sessionGeneration: 1, turnId: 'test-turn',
    currentTime: '2026-10-13T11:00:00.000Z', timezone: 'Asia/Shanghai', temporary: false,
    contextVersion: 1, personaVersion: 1, deletionEpoch: 0, selectedEntity: null,
    availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: [], memories: [], activeTasks: [],
    ...patch
  }
}
