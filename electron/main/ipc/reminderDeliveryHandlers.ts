import type { R1ReminderDelivery } from '../r1/reminderDelivery.js'
type Ipc = { handle(channel: string, listener: (event: any, payload?: any) => unknown): void }
export function registerReminderDeliveryHandlers(service: R1ReminderDelivery, ipc: Ipc): void {
  const observed = new WeakSet<object>()
  ipc.handle('r1.reminders.prepareDelivery', async (event, input) => {
    const sender = event.sender
    if (!observed.has(sender)) { observed.add(sender); sender.once('destroyed', () => service.cancel(sender.id)) }
    try { return { ok: true, data: await service.prepare(sender.id, input) } }
    catch { return { ok: false, error: { code: 'REMINDER_SPEECH_UNAVAILABLE', message: '语音提醒未完成，到期记录仍保留。' } } }
  })
  ipc.handle('r1.reminders.cancelDelivery', (event, input) => {
    if (typeof input?.requestId !== 'string') return { ok: false, error: { code: 'NOTICE_REQUEST_INVALID', message: '请求标识无效。' } }
    service.cancel(event.sender.id, input.requestId); return { ok: true, data: null }
  })
  ipc.handle('r1.reminders.reportDeliveryPlayback', (event, input) => {
    try { service.reportPlayback(event.sender.id, input); return { ok: true, data: null } }
    catch { return { ok: false, error: { code: 'NOTICE_PLAYBACK_INVALID', message: '播放回执无效。' } } }
  })
}
