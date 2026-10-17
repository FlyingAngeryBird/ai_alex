import type { TaskDeliveryAudio, TaskDeliveryRequest } from '../../electron/main/r1/taskDelivery'
type Notice = { key: string; taskId: string; goalVersion: number; resultId: string | null; completionStatus: string }
/** Wait for an idle gap; cancel immediately on user/assistant activity. Never replay an attempted brief. */
export function createTaskDeliveryCoordinator(options: {
  prepare(input: TaskDeliveryRequest): Promise<{ ok: boolean; data?: TaskDeliveryAudio | null }>
  cancel(requestId: string): void; play(audio: TaskDeliveryAudio): Promise<void>; stop(): void;
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
    if (previous) { options.cancel(previous.requestId); options.stop() }
  }
  function update(next: Notice | null, maySpeak: boolean): void {
    notice = next; allowed = maySpeak
    if (disposed || !maySpeak || !next || (active && next.key !== active.key) || (timer && scheduledKey !== next.key)) cancel()
    if (disposed || !maySpeak || !next?.resultId || next.completionStatus === 'failed' || attempted.has(next.key) || active || timer) return
    const expected = next
    scheduledKey = next.key
    timer = setTimeout(() => {
      timer = null; scheduledKey = null
      if (disposed || !allowed || notice?.key !== expected.key || attempted.has(expected.key)) return
      const requestId = (options.requestId ?? (() => crypto.randomUUID()))()
      active = { key: expected.key, requestId }; attempted.add(expected.key)
      const current = () => !disposed && allowed && active?.requestId === requestId && notice?.key === expected.key
      void options.prepare({ taskId: expected.taskId, goalVersion: expected.goalVersion, resultId: expected.resultId!, requestId })
        .then(async result => { if (current() && result.ok && result.data) await options.play(result.data) })
        .catch(() => undefined) // The truthful result card remains available.
    }, options.idleMs ?? 600)
  }
  return { update, cancel, finished() { active = null }, dispose() { disposed = true; cancel() } }
}
