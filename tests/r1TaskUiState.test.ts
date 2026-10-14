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
