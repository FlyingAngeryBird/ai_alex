import { R1_SCHEMA_VERSION, type R1Database } from './database.js'
import type { ServiceCheckReport } from './serviceDiagnostics.js'
import { safeNativeFailureDetails } from '../providers/nativeRealtimeDiagnostics.js'

const voiceStages = ['space_up', 'asr_final', 'llm_request_start', 'llm_response_start', 'llm_first_raw_delta', 'llm_first_delta',
  'llm_done', 'tts_session_ready', 'tts_first_push', 'tts_first_audio', 'tts_play_invoked', 'tts_play_start', 'tts_play_end'] as const
const eventKinds = new Set(['memory_context_invalidated', 'memory_forgotten', 'topic_saved', 'tool_committed'])
export function buildDiagnosticExport(db: R1Database, metadata: { appVersion: string; assetRelease: string; platform: string; osRelease: string; configurationRevision: number;
  electronVersion: string; nodeVersion: string; configured: Record<string, boolean>; serviceChecks: ServiceCheckReport[] }, voiceTrace: unknown) {
  const trace: Record<string, number> = {}
  if (voiceTrace && typeof voiceTrace === 'object' && !Array.isArray(voiceTrace)) for (const stage of voiceStages) {
    const value = (voiceTrace as Record<string, unknown>)[stage]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) trace[stage] = value
  }
  const events = (db.prepare('SELECT occurred_at,kind FROM event_log ORDER BY rowid DESC LIMIT 100').all() as { occurred_at: string; kind: string }[])
    .filter(row => eventKinds.has(row.kind) && Number.isFinite(Date.parse(row.occurred_at)))
    .map(row => ({ at: row.occurred_at, stage: row.kind }))
  const receipts = (db.prepare('SELECT status,created_at FROM receipts ORDER BY rowid DESC LIMIT 100').all() as { status: string; created_at: string }[])
    .filter(row => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(row.status) && Number.isFinite(Date.parse(row.created_at)))
    .map(row => ({ at: row.created_at, stage: 'receipt_committed', status: row.status }))
  return { format: 'seamo-r1-diagnostics', formatVersion: 1, createdAt: new Date().toISOString(), schema: R1_SCHEMA_VERSION,
    runtime: { appVersion: metadata.appVersion, assetRelease: metadata.assetRelease, platform: metadata.platform, osRelease: metadata.osRelease,
      electronVersion: metadata.electronVersion, nodeVersion: metadata.nodeVersion },
    configurationRevision: metadata.configurationRevision, configured: metadata.configured, serviceChecks: metadata.serviceChecks.map(check => ({ service: check.service, status: check.status,
      code: check.code, checkedAt: check.checkedAt, durationMs: check.durationMs, scope: check.scope, configurationRevision: check.configurationRevision,
      ...(safeNativeFailureDetails(check.details) ? { details: safeNativeFailureDetails(check.details) } : {}) })),
    trace: { clock: 'renderer_performance_now_ms', stages: trace, crossProcessLatencyCalculated: false }, events, receipts,
    privacy: { rawAudioIncluded: false, messageBodiesIncluded: false, credentialsIncluded: false, automaticallyUploaded: false } }
}
