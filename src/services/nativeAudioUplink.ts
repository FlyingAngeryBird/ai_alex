/** Pace captured PCM at its real duration and bound stalls without flooding IPC. */
export function createNativeAudioUplink(options: {
  send(pcm: Uint8Array): Promise<void>; onError(): void; onSent?(): void;
  now?: () => number; maxBufferedMs?: number; sendTimeoutMs?: number;
}) {
  const now = options.now ?? (() => performance.now())
  const queue: Array<{ pcm: Uint8Array; at: number }> = []
  let queuedBytes = 0, pending = false, closed = false, nextAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null, timeout: ReturnType<typeof setTimeout> | null = null
  function stop(): void {
    closed = true; queue.length = 0; queuedBytes = 0
    if (timer) clearTimeout(timer)
    if (timeout) clearTimeout(timeout)
    timer = null; timeout = null
  }
  function fail(): void { if (closed) return; stop(); options.onError() }
  function pump(): void {
    if (closed || pending || timer || !queue.length) return
    const wait = nextAt - now()
    if (wait > 0) { timer = setTimeout(() => { timer = null; pump() }, wait); return }
    const frame = queue.shift()!; queuedBytes -= frame.pcm.byteLength
    if (now() - frame.at > (options.maxBufferedMs ?? 500)) { fail(); return }
    const duration = frame.pcm.byteLength / 32, sentAt = now()
    // Keep the sample clock across small timer delays; resetting it to now on
    // every packet accumulates timer rounding until a healthy stream overflows.
    nextAt = sentAt - nextAt >= duration ? sentAt + duration : nextAt + duration
    pending = true
    timeout = setTimeout(fail, options.sendTimeoutMs ?? 1000)
    Promise.resolve().then(() => { if (!closed) return options.send(frame.pcm) }).then(() => {
      if (!closed) options.onSent?.()
    }, fail).finally(() => {
      if (timeout) clearTimeout(timeout)
      timeout = null; pending = false
      if (!closed) pump()
    })
  }
  function enqueue(pcm: Uint8Array): void {
    if (closed) return
    if (!(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > 32000 ||
      (queuedBytes + pcm.byteLength) / 32 > (options.maxBufferedMs ?? 500)) { fail(); return }
    queue.push({ pcm, at: now() }); queuedBytes += pcm.byteLength; pump()
  }
  return { enqueue, stop }
}
