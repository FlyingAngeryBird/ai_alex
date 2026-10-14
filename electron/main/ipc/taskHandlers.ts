import { exportArtifact, type ArtifactExportInput } from '../r1/artifactExport.js'
import { ipcMain, dialog } from 'electron'
import type { R1TaskSupervisor } from '../r1/taskSupervisor.js'
import type { R1Artifacts } from '../r1/artifacts.js'
import type { R1SessionMode } from '../r1/sessionMode.js'
type Ipc = { handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown): void }
export function registerTaskHandlers(tasks: R1TaskSupervisor, artifacts: R1Artifacts, mode: R1SessionMode,
  ipc: Ipc = ipcMain): void {
  const action = (run: (input: Record<string, unknown>) => unknown) => (_event: unknown, input?: unknown) => {
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_TASK_PAYLOAD')
      return { ok: true, data: run(input as Record<string, unknown>) }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'TASK_OPERATION_FAILED'
      return { ok: false, error: { code, message: code } }
    }
  }
  const owner = () => mode.temporary ? mode.sessionId || '__missing_temporary_session__' : null
  const permitted = (id: unknown) => {
    if (typeof id !== 'string' || !tasks.list(owner()).some(task => task.taskId === id)) throw new Error('TASK_NOT_FOUND')
    return id
  }
  ipc.handle('r1.artifacts.export', async (_event, input) => {
    try {
      const data = await exportArtifact(artifacts, input as ArtifactExportInput, owner, async (name, extension) => {
        const result = await dialog.showSaveDialog({ defaultPath: name,
          filters: [{ name: extension === 'md' ? 'Markdown' : '纯文本', extensions: [extension] }] })
        return result.canceled ? null : result.filePath ?? null
      })
      return { ok: true, data }
    } catch { return { ok: false, error: { code: 'ARTIFACT_EXPORT_FAILED', message: '导出未完成，请检查版本和保存位置后重试。' } } }
  })
  ipc.handle('r1.tasks.list', () => ({ ok: true, data: tasks.list(owner()) }))
  ipc.handle('r1.tasks.get', action(input => tasks.get(permitted(input.taskId))))
  for (const method of ['pause', 'resume', 'cancel'] as const) {
    ipc.handle(`r1.tasks.${method}`, action(input => {
      if (!Number.isSafeInteger(input.expectedGoalVersion) || Number(input.expectedGoalVersion) < 1) throw new Error('INVALID_TASK_VERSION')
      return tasks[method](permitted(input.taskId), input.expectedGoalVersion as number)
    }))
  }
  ipc.handle('r1.artifacts.get', action(input => artifacts.get(input.artifactId as string, owner(), input.version as number | undefined)))
  ipc.handle('r1.artifacts.revise', action(input => artifacts.revise({ artifactId: input.artifactId as string,
    expectedVersion: input.expectedVersion as number, content: input.content as string, title: input.title as string | undefined,
    target: input.target as Parameters<R1Artifacts['revise']>[0]['target'], temporaryOwner: owner() })))
  ipc.handle('r1.artifacts.undo', action(input => artifacts.undo({ artifactId: input.artifactId as string,
    expectedVersion: input.expectedVersion as number, restoreVersion: input.restoreVersion as number, temporaryOwner: owner() })))
  ipc.handle('r1.artifacts.save', action(input => artifacts.save({ artifactId: input.artifactId as string,
    expectedVersion: input.expectedVersion as number, actionId: input.actionId as string,
    kind: input.kind as 'note' | 'todo' | undefined,
    expectedItemVersion: input.expectedItemVersion as number | undefined, temporaryOwner: owner(),
    temporarySaveConfirmed: input.temporarySaveConfirmed === true, replacementConfirmed: input.replacementConfirmed === true })))
}
