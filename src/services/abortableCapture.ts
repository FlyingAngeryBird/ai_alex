export function withCaptureAbort<T>(pending: Promise<T>, signal?: AbortSignal, onLate?: (value: T) => void): Promise<T> {
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    let finished = false
    const aborted = () => { if (!finished) { finished = true; reject(new Error('VOICE_CAPTURE_CANCELLED')) } }
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
    pending.then(value => {
      signal.removeEventListener('abort', aborted)
      if (finished) { try { onLate?.(value) } catch { /* A cancelled capture cannot become a new active request. */ } }
      else { finished = true; resolve(value) }
    }, error => { signal.removeEventListener('abort', aborted); if (!finished) { finished = true; reject(error) } })
  })
}
export function acquireAudioInput(devices: Pick<MediaDevices, 'getUserMedia'>, audio: MediaTrackConstraints | boolean, signal?: AbortSignal): Promise<MediaStream> {
  if (signal?.aborted) return Promise.reject(new Error('VOICE_CAPTURE_CANCELLED'))
  return withCaptureAbort(devices.getUserMedia({ audio }), signal, stream => stream.getTracks().forEach(track => track.stop()))
}
