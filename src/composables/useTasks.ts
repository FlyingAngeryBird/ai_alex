import { computed, ref } from 'vue'
import type { R1Api } from '../../electron/shared/r1Api'
import type { R1Task } from '../../electron/main/r1/taskSupervisor'

/** Scope changes invalidate pending reads and controls; closing a panel does not. */
export function useTasks(api: R1Api['tasks']) {
  const tasks = ref<R1Task[]>([])
  const selectedId = ref<string | null>(null)
  const error = ref('')
  const busy = ref(false)
  const loading = ref(false)
  const recoveryIds = ref<string[]>([])
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
    stopEvents = api.onChanged(() => { void refresh() })
    void refresh()
  }
  function dispose(): void {
    disposed = true
    epoch++
    stopEvents?.()
    stopEvents = null
  }
  return { tasks, selectedId, selected, error, busy, loading, recoveryTasks, dismissRecovery: () => { recoveryIds.value = [] }, refresh, changeScope, control, start, dispose }
}
