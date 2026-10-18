import { randomUUID } from 'node:crypto'
import type { R1Database } from './database.js'

export const musicDiagnosticProviders = ['all', 'netease', 'kuwo', 'joox', 'unknown'] as const
export const musicDiagnosticPhases = ['search', 'play', 'pause', 'resume', 'next', 'seek', 'volume', 'queue', 'favorite', 'feedback', 'exit', 'unknown'] as const
export type MusicDiagnosticProvider = (typeof musicDiagnosticProviders)[number]
export type MusicDiagnosticPhase = (typeof musicDiagnosticPhases)[number]
export type MusicFailureDiagnostic = {
  provider: MusicDiagnosticProvider
  phase: MusicDiagnosticPhase
  code: string
  upstreamStatus: number | null
  traceId: string
  durationMs: number
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,80}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function normalizeMusicDiagnosticProvider(value: unknown): MusicDiagnosticProvider {
  return typeof value === 'string' && (musicDiagnosticProviders as readonly string[]).includes(value) ? value as MusicDiagnosticProvider : 'unknown'
}

export function normalizeMusicDiagnosticPhase(value: unknown): MusicDiagnosticPhase {
  return typeof value === 'string' && (musicDiagnosticPhases as readonly string[]).includes(value) ? value as MusicDiagnosticPhase : 'unknown'
}

/** Only uppercase error codes are retained; anything else is unknown. Never keeps an error message. */
export function safeMusicDiagnosticCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return SAFE_CODE.test(message) ? message : 'unknown'
}

/** Provider HTTP status only when it is a plausible status code; never keeps the URL or body. */
export function safeMusicUpstreamStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null
}

function safeDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(600_000, Math.max(0, Math.round(value))) : 0
}

export function recordMusicDiagnosticFailure(db: R1Database, input: {
  provider?: unknown; phase?: unknown; error: unknown; traceId?: unknown; durationMs?: unknown
}): MusicFailureDiagnostic {
  const failure: MusicFailureDiagnostic = {
    provider: normalizeMusicDiagnosticProvider(input.provider), phase: normalizeMusicDiagnosticPhase(input.phase),
    code: safeMusicDiagnosticCode(input.error), upstreamStatus: safeMusicUpstreamStatus(input.error),
    traceId: typeof input.traceId === 'string' && UUID.test(input.traceId) ? input.traceId : randomUUID(),
    durationMs: safeDuration(input.durationMs)
  }
  db.prepare('INSERT INTO event_log(event_id,occurred_at,kind,owner_id,payload_json) VALUES(?,?,?,?,?)')
    .run(randomUUID(), new Date().toISOString(), 'music_failure', null, JSON.stringify(failure))
  return failure
}

/** Reads a persisted payload defensively; extra keys (query/url/body/headers) are dropped. */
export function sanitizeMusicFailurePayload(payload: unknown): MusicFailureDiagnostic | null {
  if (!payload || typeof payload !== 'object') return null
  const value = payload as Record<string, unknown>
  if (value.provider === undefined || value.phase === undefined || value.code === undefined ||
    value.traceId === undefined || value.durationMs === undefined) return null
  const provider = normalizeMusicDiagnosticProvider(value.provider)
  const phase = normalizeMusicDiagnosticPhase(value.phase)
  if (provider === 'unknown' && value.provider !== 'unknown') return null
  if (phase === 'unknown' && value.phase !== 'unknown') return null
  const code = typeof value.code === 'string' && SAFE_CODE.test(value.code) ? value.code : 'unknown'
  const upstreamStatus = value.upstreamStatus === null || value.upstreamStatus === undefined ? null
    : typeof value.upstreamStatus === 'number' && Number.isInteger(value.upstreamStatus) && value.upstreamStatus >= 100 && value.upstreamStatus <= 599
      ? value.upstreamStatus : null
  if (typeof value.traceId !== 'string' || !UUID.test(value.traceId)) return null
  if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 600_000) return null
  return { provider, phase, code, upstreamStatus, traceId: value.traceId, durationMs: Math.round(value.durationMs) }
}
