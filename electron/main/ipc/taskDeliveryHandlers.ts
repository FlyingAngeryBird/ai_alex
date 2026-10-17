import type { R1TaskDelivery, TaskDeliveryRequest } from '../r1/taskDelivery.js'
type Ipc = { handle(channel: string, listener: (event: any, payload?: any) => unknown): void }
export function registerTaskDeliveryHandlers(service: R1TaskDelivery, ipc: Ipc): void {
  const observed = new WeakSet<object>()
  ipc.handle('r1.tasks.prepareDelivery', async (event, input: TaskDeliveryRequest) => {
    const sender = event.sender
    if (!observed.has(sender)) { observed.add(sender); sender.once('destroyed', () => service.cancel(sender.id)) }
    try { return { ok: true, data: await service.prepare(sender.id, input) } }
    catch { return { ok: false, error: { code: 'TASK_DELIVERY_UNAVAILABLE', message: '播报未完成，委托结果仍可查看。' } } }
  })
  ipc.handle('r1.tasks.cancelDelivery', (event, input) => {
    if (typeof input?.requestId !== 'string') return { ok: false, error: { code: 'TASK_DELIVERY_INPUT_INVALID', message: '请求标识无效。' } }
    service.cancel(event.sender.id, input.requestId)
    return { ok: true, data: null }
  })
}
