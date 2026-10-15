import { ref } from 'vue'
import type { AppPreferences, PreferencesPatch } from '../../electron/main/r1/preferences'
import type { R1Api } from '../../electron/shared/r1Api'

export function createPreferencesController(api: () => R1Api['preferences']) {
  const value = ref<AppPreferences | null>(null), error = ref(''), busy = ref(false)
  let pending: Promise<boolean> | null = null, unsubscribe: (() => void) | null = null
  function adopt(next: AppPreferences): void { if (!value.value || next.version >= value.value.version) value.value = next }
  async function load(): Promise<boolean> {
    if (pending) return pending
    pending = (async () => {
      try {
        if (!unsubscribe) unsubscribe = api().onChanged(adopt)
        const result = await api().get()
        if (!result.ok) throw new Error('PREFERENCES_UNAVAILABLE')
        adopt(result.data); error.value = ''; return true
      } catch { error.value = '偏好暂时无法读取，请重试。'; return false }
    })().finally(() => { pending = null })
    return pending
  }
  async function update(patch: Omit<PreferencesPatch, 'expectedVersion'>): Promise<boolean> {
    if (busy.value || !value.value && !await load()) return false
    busy.value = true; error.value = ''
    try {
      const result = await api().update({ ...patch, expectedVersion: value.value!.version })
      if (result.ok) { adopt(result.data); return true }
      const conflict = result.error.code === 'VERSION_CONFLICT'
      await load(); error.value = conflict ? '偏好已有新版本，已重新读取，请再操作一次。' : '偏好未保存，请重试。'
      return false
    } catch { error.value = '偏好未保存，请重试。'; return false }
    finally { busy.value = false }
  }
  function dispose(): void { unsubscribe?.(); unsubscribe = null }
  return { value, error, busy, load, update, dispose }
}
const preferences = createPreferencesController(() => window.seamoR1.preferences)
export function useAppPreferences() { return preferences }
