import { ref } from 'vue'
import { acquireAudioInput } from './abortableCapture'
import runtimeDefaults from '../../r1-assets/config/runtime.defaults.json'
type Output = { setSinkId?: (id: string) => Promise<void>; pause?: () => void; suspend?: () => Promise<void> }
export function createAudioDevices(options: {
  mediaDevices: () => Pick<MediaDevices, 'enumerateDevices' | 'getUserMedia' | 'addEventListener' | 'removeEventListener'>
  inputId(): string | null; outputId(): string | null
  onOutputFailure(): void
  outputTimeoutMs?: number
}) {
  const inputs = ref<MediaDeviceInfo[]>([]), outputs = ref<MediaDeviceInfo[]>([]), error = ref(''), refreshing = ref(false), routingActive = ref(false)
  const targets = new Set<Output>()
  const routing = new Map<Output, Promise<void>>()
  const applied = new WeakMap<Output, string>()
  const poisoned = new WeakSet<Output>(), notified = new WeakSet<Output>()
  let generation = 0, unsubscribe: (() => void) | null = null
  let permissionAbort: AbortController | null = null
  let routingCount = 0
  function stopOutputs(message: string): void {
    for (const target of targets) { notified.add(target); target.pause?.(); void target.suspend?.().catch(() => undefined) }
    error.value = message; options.onOutputFailure()
  }
  async function refresh(): Promise<void> {
    const request = ++generation; refreshing.value = true
    try {
      const devices = await options.mediaDevices().enumerateDevices()
      if (request !== generation) return
      inputs.value = devices.filter(device => device.kind === 'audioinput'); outputs.value = devices.filter(device => device.kind === 'audiooutput'); error.value = ''
    } catch { if (request === generation) error.value = '设备列表暂时无法读取，可以重试或使用系统默认设备。' }
    finally { if (request === generation) refreshing.value = false }
  }
  function start(): void {
    if (unsubscribe) return
    const devices = options.mediaDevices(), onChanged = () => { void refresh().then(() => {
      const id = options.outputId()
      if (targets.size && id && !outputs.value.some(device => device.deviceId === id)) stopOutputs('所选输出设备当前不可用，已停止播音。请重新选择设备。')
    }) }
    devices.addEventListener('devicechange', onChanged)
    unsubscribe = () => devices.removeEventListener('devicechange', onChanged)
    void refresh()
  }
  function inputConstraints(base: MediaTrackConstraints = {}): MediaTrackConstraints {
    const id = options.inputId()
    return { ...base, ...(id ? { deviceId: { exact: id } } : {}) }
  }
  function route(device: Output): Promise<void> {
    const promise = (routing.get(device) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (poisoned.has(device)) throw new Error('AUDIO_OUTPUT_TIMEOUT')
      for (let attempt = 0; attempt < 3 && targets.has(device); attempt++) {
        const id = options.outputId() ?? ''
        if (applied.get(device) !== id) {
          try {
            if (device.setSinkId) {
              let timer: ReturnType<typeof setTimeout> | undefined
              try {
                await Promise.race([device.setSinkId(id), new Promise<never>((_resolve, reject) => {
                  timer = setTimeout(() => { poisoned.add(device); if (targets.has(device) && !notified.has(device)) stopOutputs('输出设备响应超时，已停止播音。请重新开启播放。'); reject(new Error('AUDIO_OUTPUT_TIMEOUT')) }, options.outputTimeoutMs ?? runtimeDefaults.limits.connectTimeoutMs)
                })])
              } finally { if (timer) clearTimeout(timer) }
            }
            else if (id) throw new Error('AUDIO_OUTPUT_SELECTION_UNSUPPORTED')
          } catch (error) { if (!poisoned.has(device) && id !== (options.outputId() ?? '')) continue; throw error }
          applied.set(device, id)
        }
        if (id === (options.outputId() ?? '')) return
      }
      if (targets.has(device)) throw new Error('AUDIO_OUTPUT_CHANGED')
    }).finally(() => { if (routing.get(device) === promise) routing.delete(device) })
    routing.set(device, promise); return promise
  }
  async function bindOutput(target: HTMLMediaElement | AudioContext): Promise<() => void> {
    const device = target as unknown as Output
    targets.add(device)
    try { await route(device) }
    catch (error) { targets.delete(device); throw error }
    return () => { targets.delete(device); applied.delete(device) }
  }
  async function routeOutputs(): Promise<boolean> {
    routingCount++; routingActive.value = true
    try {
    const id = options.outputId() ?? ''
    const selected = [...targets], results = await Promise.allSettled(selected.map(route))
    if (id !== (options.outputId() ?? '')) return false
    if (results.some(result => result.status === 'rejected')) {
      if (results.some((result, index) => result.status === 'rejected' && targets.has(selected[index]) && !notified.has(selected[index]))) stopOutputs('输出设备切换未成功，已停止播音。请重新选择设备。')
      return false
    }
    error.value = ''; return true
    } finally { routingCount--; routingActive.value = routingCount > 0 }
  }
  async function requestPermission(signal?: AbortSignal): Promise<boolean> {
    permissionAbort?.abort(); permissionAbort = new AbortController()
    const abort = AbortSignal.any([permissionAbort.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])])
    let stream: MediaStream | null = null
    try { stream = await acquireAudioInput(options.mediaDevices(), inputConstraints(), abort); await refresh(); return true }
    catch { if (!signal?.aborted) error.value = '麦克风未能开启。可在系统隐私设置授权，或选择可用设备；文字仍可使用。'; return false }
    finally { stream?.getTracks().forEach(track => track.stop()) }
  }
  function dispose(): void { generation++; permissionAbort?.abort(); unsubscribe?.(); unsubscribe = null; targets.clear() }
  return { inputs, outputs, error, refreshing, routingActive, start, refresh, requestPermission, inputConstraints, bindOutput, routeOutputs, dispose }
}
