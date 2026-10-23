import type { TaskDeliveryAudio, TaskDeliveryRequest } from '../../electron/main/r1/taskDelivery'
import type { SpeechPlayback } from './assistantSpeech'
import type { ReminderSpeechRequest } from '../../electron/main/r1/reminderDelivery'
type Notice = { key: string; taskId: string; goalVersion: number; resultId: string | null; completionStatus: string } |
  { key: string; deliveryId: string }
type SpeechRequest = TaskDeliveryRequest | ReminderSpeechRequest
/** Wait for an idle gap; cancel immediately on user/assistant activity. Never replay an attempted brief. */
export function createTaskDeliveryCoordinator(options: {
  prepare(input: SpeechRequest): Promise<{ ok: boolean; data?: TaskDeliveryAudio | null }>
  cancel(requestId: string): void; play(audio: TaskDeliveryAudio, report: (receipt: SpeechPlayback) => void): Promise<void>; stop(): void;
  report?(input: SpeechPlayback & { requestId: string }): void
  requestId?: () => string; idleMs?: number
}) {
  let notice: Notice | null = null, allowed = false, disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let scheduledKey: string | null = null
  let active: { key: string; requestId: string } | null = null
  const attempted = new Set<string>()
  function cancel(): void {
    if (timer) clearTimeout(timer); timer = null; scheduledKey = null
    const previous = active; active = null
    if (previous) { options.stop(); options.cancel(previous.requestId) }
  }
  function update(next: Notice | null, maySpeak: boolean): void {
    notice = next; allowed = maySpeak
    if (disposed || !maySpeak || !next || (active && next.key !== active.key) || (timer && scheduledKey !== next.key)) cancel()
    if (disposed || !maySpeak || !next || (!('deliveryId' in next) && (!next.resultId || next.completionStatus === 'failed')) || attempted.has(next.key) || active || timer) return
    const expected = next
    scheduledKey = next.key
    timer = setTimeout(() => {
      timer = null; scheduledKey = null
      if (disposed || !allowed || notice?.key !== expected.key || attempted.has(expected.key)) return
      const requestId = (options.requestId ?? (() => crypto.randomUUID()))()
      active = { key: expected.key, requestId }; attempted.add(expected.key)
      const current = () => !disposed && allowed && active?.requestId === requestId && notice?.key === expected.key
      const request: SpeechRequest = 'deliveryId' in expected ? { deliveryId: expected.deliveryId, requestId } :
        { taskId: expected.taskId, goalVersion: expected.goalVersion, resultId: expected.resultId!, requestId }
      void options.prepare(request)
        .then(async result => {
          if (current() && result.ok && result.data) await options.play(result.data,
            receipt => options.report?.({ ...receipt, requestId }))
        })
        .catch(() => undefined) // The truthful result card remains available.
    }, options.idleMs ?? 600)
  }
  return { update, cancel, finished() { active = null }, dispose() { disposed = true; cancel() } }
}
