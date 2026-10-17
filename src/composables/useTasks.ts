import { computed, ref } from 'vue'
import type { R1Api } from '../../electron/shared/r1Api'
import type { R1Task, TaskEvent } from '../../electron/main/r1/taskSupervisor'

export type TaskCompletionNotice = { key: string; taskId: string; goalVersion: number; resultId: string | null;
  title: string; completionStatus: 'completed' | 'partial' | 'needs_input' | 'failed'; brief: string }

/** Scope changes invalidate pending reads and controls; closing a panel does not. */
export function useTasks(api: R1Api['tasks']) {
  const tasks = ref<R1Task[]>([])
  const selectedId = ref<string | null>(null)
  const error = ref('')
  const busy = ref(false)
  const loading = ref(false)
  const recoveryIds = ref<string[]>([])
  const completionNotices = ref<TaskCompletionNotice[]>([])
  const pendingCompletions = new Map<string, { taskId: string; goalVersion: number; resultId: string | null }>()
  const seenCompletions = new Set<string>()
  function collectCompletions(): void {
    const current = (notice: Pick<TaskCompletionNotice, 'taskId' | 'goalVersion' | 'resultId'>) => {
      const task = tasks.value.find(task => task.taskId === notice.taskId)
      return task && task.goalVersion === notice.goalVersion && task.resultId === notice.resultId &&
        ['succeeded', 'partially_succeeded', 'waiting_input', 'failed'].includes(task.status) &&
        (task.status === 'failed' || (task.result?.goalVersion === task.goalVersion && task.result.resultId === task.resultId))
    }
    completionNotices.value = completionNotices.value.filter(current)
    for (const [key, expected] of pendingCompletions) {
      const taskId = expected.taskId
      const task = tasks.value.find(task => task.taskId === taskId)
      if (!task || task.goalVersion !== expected.goalVersion || !current(expected)) { pendingCompletions.delete(key); continue }
      if (!seenCompletions.has(key)) {
        seenCompletions.add(key)
        const result = task.status === 'failed' ? null : task.result
        completionNotices.value.push({ key, taskId, goalVersion: task.goalVersion, resultId: task.resultId,
          title: task.goal, completionStatus: result?.completionStatus ?? 'failed',
          brief: result?.replyBrief ?? '这项委托未能完成，可以查看已保存的进度。' })
      }
      pendingCompletions.delete(key)
    }
    completionNotices.value = completionNotices.value.slice(-5)
  }
  const recoveryTasks = computed(() => tasks.value.filter(task => recoveryIds.value.includes(task.taskId) && task.status === 'needs_resume'))
  let checkedRecovery = false
  const selected = computed(() => tasks.value.find(task => task.taskId === selectedId.value) ?? null)
  let epoch = 0
  let revision = 0
  let disposed = false
  let stopEvents: (() => void) | null = null

  async function refresh(): Promise<void> {
    const scope = epoch
    const request = ++revision
    loading.value = true
    try {
      const result = await api.list()
      if (disposed || scope !== epoch || request !== revision) return
      if (!result.ok) throw new Error(result.error.code)
      tasks.value = result.data
      collectCompletions()
      if (!checkedRecovery) { checkedRecovery = true; recoveryIds.value = tasks.value.filter(task => task.status === 'needs_resume').map(task => task.taskId) }
      if (!tasks.value.some(task => task.taskId === selectedId.value)) selectedId.value = null
      error.value = ''
    } catch {
      if (!disposed && scope === epoch && request === revision) error.value = '任务暂时无法读取，请重试。'
    } finally {
      if (!disposed && scope === epoch && request === revision) loading.value = false
    }
  }
  function changeScope(): void {
    epoch++
    pendingCompletions.clear(); completionNotices.value = []; seenCompletions.clear()
    tasks.value = []
    recoveryIds.value = []; checkedRecovery = true
    selectedId.value = null
    error.value = ''
    busy.value = false
    void refresh()
  }
  async function control(action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    const task = selected.value
    if (disposed || busy.value || !task) return
    const scope = epoch
    busy.value = true
    error.value = ''
    try {
      const result = await api[action]({ taskId: task.taskId, expectedGoalVersion: task.goalVersion })
      if (disposed || scope !== epoch) return
      // Fetch authoritative state: an event may have already advanced beyond this receipt.
      await refresh()
      if (!disposed && scope === epoch && !result.ok) error.value = ({ VERSION_CONFLICT: '任务已变化，请查看最新状态后重试。',
        TASK_CONTEXT_REVALIDATION_REQUIRED: '记忆或授权已变化，请在对话中重新说明本次条件。', TASK_SOURCE_NOT_FOUND: '原始对话已清理，请重新提出这项委托。',
        TASK_SOURCE_SUPPRESSED: '原始来源已失效，请重新提出这项委托。', TASK_ASSET_RELEASE_UNAVAILABLE: '这项旧委托的版本暂不可用，请保留结果并重新提出。' } as Record<string,string>)[result.error.code] ?? '任务操作未完成，请重试。'
    } catch {
      if (!disposed && scope === epoch) error.value = '任务操作未完成，请重试。'
    } finally { if (!disposed && scope === epoch) busy.value = false }
  }
  function start(): void {
    if (disposed || stopEvents) return
    // Re-read the current scope instead of trusting a queued event from a prior session.
    stopEvents = api.onChanged((event: TaskEvent) => {
      if (disposed) return
      if (['completed', 'waiting_input'].includes(event.reason) &&
        (event.task.result || event.task.status === 'failed')) {
        pendingCompletions.set(`${event.task.taskId}:${event.task.goalVersion}:${event.task.resultId ?? 'failed'}`, {
          taskId: event.task.taskId, goalVersion: event.task.goalVersion, resultId: event.task.resultId })
      }
      // Cards are derived from a fresh authoritative read, never event payload
      // prose. Any overlapping refresh can drain the pending completion IDs.
      void refresh()
    })
    void refresh()
  }
  function dispose(): void {
    disposed = true
    epoch++
    pendingCompletions.clear(); completionNotices.value = []
    stopEvents?.()
    stopEvents = null
  }
  return { tasks, selectedId, selected, error, busy, loading, recoveryTasks, completionNotices,
    clearCompletionNotices() { epoch++; pendingCompletions.clear(); completionNotices.value = []; void refresh() },
    dismissCompletion: (key: string) => { completionNotices.value = completionNotices.value.filter(notice => notice.key !== key) },
    dismissRecovery: () => { recoveryIds.value = [] }, refresh, changeScope, control, start, dispose }
}
