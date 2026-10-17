import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export type OnboardingState = { completed: boolean; skipped: boolean; completedAt: string | null }

/** Local UI preference only; never grants memory, microphone or service access. */
export class R1Onboarding {
  constructor(private readonly path: string) {}

  get(): OnboardingState {
    if (!existsSync(this.path)) return { completed: false, skipped: false, completedAt: null }
    const value = JSON.parse(readFileSync(this.path, 'utf8')) as OnboardingState
    if (value.completed !== true || typeof value.skipped !== 'boolean' || typeof value.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.completedAt))) throw new Error('ONBOARDING_STATE_INVALID')
    return { completed: true, skipped: value.skipped, completedAt: value.completedAt }
  }

  complete(input: { skipped: boolean }): OnboardingState {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
      typeof input.skipped !== 'boolean') throw new Error('ONBOARDING_INPUT_INVALID')
    const value: OnboardingState = { completed: true, skipped: input.skipped, completedAt: new Date().toISOString() }
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.path)
    } finally { rmSync(temporary, { force: true }) }
    return value
  }
}
