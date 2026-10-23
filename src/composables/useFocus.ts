import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { FocusEvent, FocusState } from '../../electron/main/r1/focus'

export function useFocus(onCompleted: (event: FocusEvent) => void) {
  const state = ref<FocusState | null>(null)
  const busy = ref(false)
  const error = ref('')
  const active = computed(() => state.value?.state === 'running' || state.value?.state === 'paused')
  let stopEvents: (() => void) | null = null
  let eventRevision = 0
  function message(code: string): string {
    if (code === 'FOCUS_ALREADY_ACTIVE') return '已有一段专注，请先继续或结束它。'
    if (code === 'VERSION_CONFLICT') return '专注状态已变化，请重新操作。'
    if (code === 'FOCUS_DEVICE_SUSPENDED') return '设备正在休眠，请唤醒后再继续。'
    return '专注操作未成功，请重试。'
  }
  async function refresh(): Promise<void> {
    const revision = eventRevision
    try {
      const result = await window.seamoR1.focus.getState()
      if (revision !== eventRevision) return
      if (result.ok) state.value = result.data
      else error.value = '专注状态暂时无法读取。'
    } catch { error.value = '专注状态暂时无法读取。' }
  }
  async function start(durationSec: number, endTargetTrackKey: string | null = null): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    error.value = ''
    try {
      const result = await window.seamoR1.focus.start({ actionId: crypto.randomUUID(), durationSec,
        endMusicRule: endTargetTrackKey ? 'pause_user_selected_track' : 'none', endTargetTrackKey })
      if (!result.ok) { error.value = message(result.error.code); await refresh(); return false }
      state.value = result.data.focus
      return true
    } catch { error.value = '专注没有启动，请重试。'; return false }
    finally { busy.value = false }
  }
  async function control(action: 'pause' | 'resume' | 'stop'): Promise<void> {
    if (busy.value || !state.value) return
    busy.value = true
    error.value = ''
    try {
      const result = await window.seamoR1.focus[action]({ actionId: crypto.randomUUID(),
        focusId: state.value.focusId, expectedVersion: state.value.version })
      if (result.ok) state.value = result.data.focus
      else { error.value = message(result.error.code); await refresh() }
    } catch { error.value = '专注操作未成功，请重试。' }
    finally { busy.value = false }
  }
  onMounted(() => {
    stopEvents = window.seamoR1.focus.onChanged(event => {
      eventRevision += 1
      state.value = event.focus
      if (event.reason === 'completed') onCompleted(event)
    })
    void refresh()
  })
  onBeforeUnmount(() => stopEvents?.())
  return { state, active, busy, error, start, control }
}
