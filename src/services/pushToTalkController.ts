export type PushToTalkSource = 'keyboard' | 'button'
type Phase = 'idle' | 'starting' | 'recording' | 'finishing' | 'cancelling'

export function createPushToTalkController(options: {
  start(signal: AbortSignal): Promise<boolean>
  finish(): Promise<void>
  cancel(): Promise<void>
  canStart(): boolean
  onHeldChange(held: boolean): void
  onError(error: unknown): void
  maxDurationMs?: number
}) {
  let phase: Phase = 'idle'
  let owner: PushToTalkSource | null = null
  let desired: 'held' | 'released' | 'cancelled' = 'released'
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let captureAbort: AbortController | null = null
  const idleWaiters: Array<() => void> = []
  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  function idle(): void {
    clearTimer()
    phase = 'idle'
    owner = null
    captureAbort = null
    options.onHeldChange(false)
    idleWaiters.splice(0).forEach(resolve => resolve())
  }
  async function settle(action: 'finish' | 'cancel'): Promise<void> {
    phase = action === 'finish' ? 'finishing' : 'cancelling'
    clearTimer()
    try { await options[action]() } catch (error) { options.onError(error) }
    finally { idle() }
  }
  async function press(source: PushToTalkSource): Promise<void> {
    if (disposed || phase !== 'idle' || !options.canStart()) return
    owner = source
    desired = 'held'
    phase = 'starting'
    captureAbort = new AbortController()
    options.onHeldChange(true)
    let started = false
    try { started = await options.start(captureAbort.signal) } catch (error) { options.onError(error) }
    if (!started) { idle(); return }
    if ((desired as string) === 'cancelled' || disposed) await settle('cancel')
    else if ((desired as string) === 'released') await settle('finish')
    else {
      phase = 'recording'
      timer = setTimeout(() => { void release(source) }, options.maxDurationMs ?? 60_000)
    }
  }
  async function release(source: PushToTalkSource): Promise<void> {
    if (owner !== source || !['starting', 'recording'].includes(phase) || desired === 'cancelled') return
    desired = 'released'
    options.onHeldChange(false)
    clearTimer()
    if (phase === 'recording') await settle('finish')
  }
  async function cancel(): Promise<void> {
    if (!['starting', 'recording'].includes(phase)) return
    desired = 'cancelled'
    if (phase === 'starting') captureAbort?.abort()
    options.onHeldChange(false)
    clearTimer()
    if (phase === 'recording') await settle('cancel')
  }
  async function dispose(): Promise<void> { disposed = true; await cancel() }
  function whenIdle(): Promise<void> {
    return phase === 'idle' ? Promise.resolve() : new Promise(resolve => idleWaiters.push(resolve))
  }
  return { press, release, cancel, dispose, whenIdle, owner: () => owner, isBusy: () => phase !== 'idle' }
}
