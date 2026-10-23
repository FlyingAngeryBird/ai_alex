import { expect, it, vi } from 'vitest'
import { useTasks } from '../src/composables/useTasks'
import type { R1Api } from '../electron/shared/r1Api'
import type { R1Task } from '../electron/main/r1/taskSupervisor'

it('discards an ordinary task list that arrives after a temporary scope switch', async () => {
  let finish!: (value: unknown) => void
  const api = { list: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValue({ ok: true, data: [] }), onChanged: vi.fn(() => () => undefined) } as unknown as R1Api['tasks']
  const state = useTasks(api)
  const pending = state.refresh()
  state.changeScope()
  await Promise.resolve()
  finish({ ok: true, data: [{ taskId: 'ordinary', goal: '私人内容' }] })
  await pending
  expect(state.tasks.value).toEqual([])
  expect(state.loading.value).toBe(false)
})

it('uses the selected goal version and retains state until the real control receipt arrives', async () => {
  const task = { taskId: 'task', goalVersion: 4, status: 'running' } as R1Task
  let finish!: (value: unknown) => void
  const api = { list: vi.fn().mockResolvedValueOnce({ ok: true, data: [task] })
    .mockResolvedValue({ ok: true, data: [{ ...task, status: 'paused' }] }),
    pause: vi.fn(() => new Promise(resolve => { finish = resolve })) } as unknown as R1Api['tasks']
  const state = useTasks(api)
  await state.refresh()
  state.selectedId.value = 'task'
  const pending = state.control('pause')
  expect(api.pause).toHaveBeenCalledWith({ taskId: 'task', expectedGoalVersion: 4 })
  expect(state.selected.value?.status).toBe('running')
  finish({ ok: true, data: { ...task, status: 'paused' } })
  await pending
  expect(state.selected.value?.status).toBe('paused')
  expect(state.busy.value).toBe(false)
})

it('shows one passive recovery notice without resuming tasks, and does not repeat it after dismissal',async()=>{
 const task={taskId:'saved',goalVersion:2,status:'needs_resume'} as R1Task
 const api={list:vi.fn().mockResolvedValue({ok:true,data:[task]}),resume:vi.fn()} as unknown as R1Api['tasks']
 const state=useTasks(api);await state.refresh()
 expect(state.recoveryTasks.value).toHaveLength(1);expect(api.resume).not.toHaveBeenCalled()
 state.dismissRecovery();await state.refresh()
 expect(state.recoveryTasks.value).toHaveLength(0)
 state.changeScope();await Promise.resolve()
 expect(state.recoveryTasks.value).toHaveLength(0)
})

function completionTask(version = 1, resultId = 'result', completionStatus: 'completed' | 'partial' | 'needs_input' = 'completed'): R1Task {
 return { taskId: 'task', goalVersion: version, goal: '整理资料', status: completionStatus === 'completed' ? 'succeeded' : completionStatus === 'partial' ? 'partially_succeeded' : 'waiting_input',
 resultId, result: { resultId, goalVersion: version, completionStatus, replyBrief: '真实结果摘要', sourceRefs: [], artifacts: [], unresolved: [], candidateRefs: [], entityReceipts: [] } } as unknown as R1Task
}
function taskEvent(task: R1Task, eventId = 'event') {
 return { eventId, occurredAt: '2026-10-17T08:00:00Z', reason: task.status === 'waiting_input' ? 'waiting_input' : 'completed', task } as import('../electron/main/r1/taskSupervisor').TaskEvent
}
it('shows only fresh authoritative completion results, deduplicates event IDs and does not replay dismissed results', async () => {
 let current = completionTask(), notify!: (event: ReturnType<typeof taskEvent>) => void
 const api = { list: vi.fn(async () => ({ ok: true, data: [current] })), onChanged(fn: typeof notify) { notify = fn; return () => undefined } } as unknown as R1Api['tasks']
 const state = useTasks(api); state.start(); await vi.waitFor(() => expect(state.tasks.value).toHaveLength(1))
 expect(state.completionNotices.value).toEqual([]) // Loading history is not a new event.
 notify(taskEvent({ ...current, result: { ...current.result!, replyBrief: 'event prose must not be trusted' } }))
 await vi.waitFor(() => expect(state.completionNotices.value).toHaveLength(1))
 expect(state.completionNotices.value[0].brief).toBe('真实结果摘要')
 const key = state.completionNotices.value[0].key
 state.dismissCompletion(key); notify(taskEvent(current, 'duplicate-with-another-id')); await state.refresh()
 expect(state.completionNotices.value).toEqual([]); state.dispose()
})
it('drops old goals and removes notices when the authoritative task is cancelled', async () => {
 let current = completionTask(2, 'new', 'partial'), notify!: (event: ReturnType<typeof taskEvent>) => void
 const api = { list: vi.fn(async () => ({ ok: true, data: [current] })), onChanged(fn: typeof notify) { notify = fn; return () => undefined } } as unknown as R1Api['tasks']
 const state = useTasks(api); state.start(); await state.refresh()
 notify(taskEvent(completionTask(1, 'old'))); await state.refresh(); expect(state.completionNotices.value).toEqual([])
 notify(taskEvent(current)); await state.refresh(); expect(state.completionNotices.value[0].completionStatus).toBe('partial')
 current = { ...current, status: 'cancelled' }; await state.refresh(); expect(state.completionNotices.value).toEqual([]); state.dispose()
})
it('coalesces overlapping reads without losing the latest result or showing a stale result', async () => {
 let notify!: (event: ReturnType<typeof taskEvent>) => void
 const task = completionTask(1, 'one'), next = completionTask(2, 'two', 'needs_input')
 let first!: (value: unknown) => void, second!: (value: unknown) => void
 const list = vi.fn().mockResolvedValueOnce({ ok: true, data: [] })
 .mockImplementationOnce(() => new Promise(resolve => { first = resolve }))
 .mockImplementationOnce(() => new Promise(resolve => { second = resolve }))
 const state = useTasks({ list, onChanged(fn: typeof notify) { notify = fn; return () => undefined } } as unknown as R1Api['tasks'])
 state.start(); await Promise.resolve()
 notify(taskEvent(next)); notify(taskEvent(task))
 second({ ok: true, data: [next] }); await vi.waitFor(() => expect(state.completionNotices.value).toHaveLength(1))
 first({ ok: true, data: [task] }); await Promise.resolve()
 expect(state.completionNotices.value.map(n => n.resultId)).toEqual(['two'])
 expect(state.completionNotices.value[0].completionStatus).toBe('needs_input'); state.dispose()
})
it('clears queued completions on scope and memory invalidation without adopting late reads', async () => {
 let notify!: (event: ReturnType<typeof taskEvent>) => void, finish!: (value: unknown) => void
 const task = completionTask()
 const list = vi.fn().mockResolvedValueOnce({ ok: true, data: [] })
 .mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue({ ok: true, data: [] })
 const state = useTasks({ list, onChanged(fn: typeof notify) { notify = fn; return () => undefined } } as unknown as R1Api['tasks'])
 state.start(); await Promise.resolve(); notify(taskEvent(task)); state.changeScope(); finish({ ok: true, data: [task] }); await state.refresh()
 expect(state.completionNotices.value).toEqual([])
 list.mockResolvedValue({ ok: true, data: [task] }); notify(taskEvent(task)); await state.refresh(); expect(state.completionNotices.value).toHaveLength(1)
 state.clearCompletionNotices(); await state.refresh(); expect(state.completionNotices.value).toEqual([]); state.dispose()
})

it('does not label failed tasks as completed or display an obsolete result body', async () => {
 let current = { ...completionTask(), status: 'failed' as const }, notify!: (event: ReturnType<typeof taskEvent>) => void
 const state = useTasks({ list: async () => ({ ok: true, data: [current] }), onChanged(fn: typeof notify) { notify = fn; return () => undefined } } as unknown as R1Api['tasks'])
 state.start(); await state.refresh(); notify(taskEvent(current)); await state.refresh()
 expect(state.completionNotices.value[0].completionStatus).toBe('failed')
 expect(state.completionNotices.value[0].brief).not.toBe('真实结果摘要')
 state.dispose()
})
