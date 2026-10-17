import { afterTransactionCommit, inTransaction, type R1Database } from './database.js'

export type AppPreferences = { inputDeviceId: string | null; outputDeviceId: string | null;
  doNotDisturb: boolean; proactiveSpeechEnabled: boolean; reducedMotion: boolean; version: number }
export type PreferencesPatch = Partial<Omit<AppPreferences, 'version'>> & { expectedVersion: number }
export class R1Preferences {
  private listeners = new Set<(value: AppPreferences) => void>()
  constructor(private readonly db: R1Database) {}
  get(): AppPreferences {
    const row = this.db.prepare('SELECT * FROM app_preferences WHERE id=1').get() as {
      input_device_id: string | null; output_device_id: string | null; do_not_disturb: number; proactive_speech: number; reduced_motion: number; version: number
    }
    return { inputDeviceId: row.input_device_id, outputDeviceId: row.output_device_id, doNotDisturb: row.do_not_disturb === 1,
      proactiveSpeechEnabled: row.proactive_speech === 1, reducedMotion: row.reduced_motion === 1, version: row.version }
  }
  onChanged(listener: (value: AppPreferences) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  update(input: PreferencesPatch): AppPreferences {
    const fields = ['inputDeviceId', 'outputDeviceId', 'doNotDisturb', 'proactiveSpeechEnabled', 'reducedMotion'] as const
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
      Object.keys(input).some(key => key !== 'expectedVersion' && !(fields as readonly string[]).includes(key)) || !fields.some(key => Object.hasOwn(input, key))) throw new Error('INVALID_PREFERENCES_PATCH')
    for (const key of ['doNotDisturb', 'proactiveSpeechEnabled', 'reducedMotion'] as const) if (Object.hasOwn(input, key) && typeof input[key] !== 'boolean') throw new Error('INVALID_PREFERENCES_PATCH')
    for (const key of ['inputDeviceId', 'outputDeviceId'] as const) if (Object.hasOwn(input, key) && input[key] !== null &&
      (typeof input[key] !== 'string' || !input[key]!.trim() || input[key] !== input[key]!.trim() || input[key]!.length > 512)) throw new Error('INVALID_AUDIO_DEVICE_ID')
    return inTransaction(this.db, () => {
      const current = this.get()
      if (current.version !== input.expectedVersion) throw new Error('VERSION_CONFLICT')
      const next = { ...current, ...Object.fromEntries(fields.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]])) }
      if (fields.every(key => current[key] === next[key])) return current
      this.db.prepare('UPDATE app_preferences SET input_device_id=?,output_device_id=?,do_not_disturb=?,proactive_speech=?,reduced_motion=?,version=version+1,updated_at=? WHERE id=1')
        .run(next.inputDeviceId, next.outputDeviceId, Number(next.doNotDisturb), Number(next.proactiveSpeechEnabled), Number(next.reducedMotion), new Date().toISOString())
      const value = this.get()
      afterTransactionCommit(this.db, () => { for (const listener of this.listeners) { try { listener(structuredClone(value)) } catch { /* Committed preference does not depend on a renderer observer. */ } } })
      return value
    })
  }
}
