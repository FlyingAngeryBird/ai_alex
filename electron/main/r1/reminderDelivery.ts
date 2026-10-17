import { randomUUID } from 'node:crypto'
import type { R1Database } from './database.js'
import type { R1Conversations } from './conversations.js'
import type { R1PromptAssets } from './promptAssets.js'
import type { R1Persona } from './persona.js'
import type { AppPreferences } from './preferences.js'
import type { R1SessionMode } from './sessionMode.js'
import type { ReminderDueEvent } from './reminderScheduler.js'
import type { FocusEvent } from './focus.js'
import type { createArkResponsesProvider, ArkModelBoundary } from '../providers/arkResponsesProvider.js'
import { R1ModelRequestBoundary } from './modelBoundary.js'
import { NativePlaybackLedger } from './nativePlayback.js'
import type { TaskDeliveryAudio, TaskDeliveryPlayback } from './taskDelivery.js'

export type ReminderSpeechRequest = { deliveryId: string; requestId: string }
type Delivery = { deliveryId: string; reminderId: string | null; focusId: string | null; speakAllowed: boolean;
  deliveryKind: 'on_time' | 'missed' | 'follow_up' | 'focus_completed'; content: string;
  dueAt: string | null; timezone: string; actualFocusDurationSec: number | null }
type Candidate = { input: Delivery; valid(): boolean }
/** Only actual local scheduler events can create speech tickets. No scheduling or business writes. */
export class R1ReminderDelivery {
  private pending = new Map<string, Candidate>()
  private seen = new Set<string>()
  private active = new Map<number, { requestId: string; controller: AbortController }>()
  private playback = new Map<string, { owner: number; started: boolean; ledger: NativePlaybackLedger;
    responseId: string; check(): void; timer: ReturnType<typeof setTimeout> }>()
  constructor(private readonly options: { db: R1Database; assets: R1PromptAssets; conversations: R1Conversations;
    scope(): R1SessionMode; preferences(): AppPreferences; persona(): R1Persona; configurationRevision(): number;
    provider: ReturnType<typeof createArkResponsesProvider>;
    synthesize(input: { text: string; voice: string; boundary: R1ModelRequestBoundary; signal: AbortSignal }): Promise<ArrayBuffer>
  }) {}
  private offer(key: string, input: Omit<Delivery, 'deliveryId' | 'speakAllowed'>, valid: () => boolean): string | null {
    if (this.seen.has(key)) return null
    this.seen.add(key)
    const deliveryId = randomUUID(), preferences = this.options.preferences()
    if (!this.options.scope().temporary && !preferences.doNotDisturb && preferences.proactiveSpeechEnabled && valid()) {
      this.pending.set(deliveryId, { input: { ...input, deliveryId, speakAllowed: true }, valid })
      if (this.pending.size > 5) this.pending.delete(this.pending.keys().next().value!)
    }
    return deliveryId
  }
  observeReminder(event: ReminderDueEvent): string | null {
    const row = this.options.db.prepare('SELECT * FROM reminders WHERE reminder_id=?').get(event.reminderId) as {
      reminder_id: string; schedule_version: number; body: string; due_at_utc: string; timezone: string; status: string; kind: string
    } | undefined
    if (!row || row.status !== 'due' || row.due_at_utc !== event.dueAtUtc) return null
    const valid = () => !!this.options.db.prepare("SELECT 1 FROM reminders WHERE reminder_id=? AND schedule_version=? AND status='due' AND body=? AND due_at_utc=?")
      .get(row.reminder_id, row.schedule_version, row.body, row.due_at_utc)
    return this.offer(`reminder:${row.reminder_id}:${row.schedule_version}`, {
      reminderId: row.reminder_id, focusId: null,
      deliveryKind: event.recoveredCount ? 'missed' : row.kind === 'followup' ? 'follow_up' : 'on_time',
      content: event.recoveredCount ? event.body : row.body, dueAt: row.due_at_utc,
      timezone: row.timezone, actualFocusDurationSec: null
    }, valid)
  }
  observeFocus(event: FocusEvent): string | null {
    if (event.reason !== 'completed' || event.focus.state !== 'completed') return null
    const row = this.options.db.prepare("SELECT focus_id,version,duration_sec FROM focus WHERE focus_id=? AND state='completed' AND version=?")
      .get(event.focus.focusId, event.focus.version) as { focus_id: string; version: number; duration_sec: number } | undefined
    if (!row) return null
    return this.offer(`focus:${row.focus_id}:${row.version}`, { reminderId: null, focusId: row.focus_id,
      deliveryKind: 'focus_completed', content: '这段专注计时已经完成。', dueAt: null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, actualFocusDurationSec: row.duration_sec },
    () => !!this.options.db.prepare("SELECT 1 FROM focus WHERE focus_id=? AND version=? AND state='completed'").get(row.focus_id, row.version))
  }
  cancel(owner: number, requestId?: string): void {
    const active = this.active.get(owner)
    if (active && (!requestId || active.requestId === requestId)) { active.controller.abort(); this.active.delete(owner) }
    for (const [key, value] of this.playback) if (value.owner === owner && (!requestId || key === requestId)) {
      value.ledger.interruptPending(); clearTimeout(value.timer); this.playback.delete(key)
    }
  }
  invalidate(): void {
    for (const owner of new Set([...this.active.keys(), ...[...this.playback.values()].map(value => value.owner)])) this.cancel(owner)
    this.pending.clear()
  }
  reportPlayback(owner: number, input: TaskDeliveryPlayback): void {
    if (!input || typeof input.requestId !== 'string' || !Number.isSafeInteger(input.playedUntilMs) ||
      !['started', 'playing', 'completed', 'interrupted'].includes(input.status)) throw new Error('NOTICE_PLAYBACK_INVALID')
    const receipt = this.playback.get(input.requestId)
    if (!receipt) return
    if (receipt.owner !== owner) throw new Error('NOTICE_OWNER_MISMATCH')
    if (!receipt.started && ['playing', 'completed'].includes(input.status)) throw new Error('NOTICE_PLAYBACK_NOT_STARTED')
    if (input.status !== 'interrupted') { try { receipt.check() } catch { this.cancel(owner, input.requestId); return } }
    receipt.ledger.playback({ responseId: receipt.responseId, status: input.status, playedUntilMs: input.playedUntilMs })
    if (input.status === 'started') receipt.started = true
    if (['completed', 'interrupted'].includes(input.status)) { clearTimeout(receipt.timer); this.playback.delete(input.requestId) }
  }
  async prepare(owner: number, request: ReminderSpeechRequest): Promise<TaskDeliveryAudio | null> {
    if (!request || typeof request.deliveryId !== 'string' || request.deliveryId.length > 160 ||
      typeof request.requestId !== 'string' || !/^[\w-]{1,160}$/.test(request.requestId)) throw new Error('NOTICE_REQUEST_INVALID')
    const candidate = this.pending.get(request.deliveryId), scope = { ...this.options.scope() }, preferences = this.options.preferences()
    const persona = this.options.persona(), revision = this.options.configurationRevision()
    const voice = persona.voiceId || process.env.VOLCENGINE_REALTIME_VOICE || ''
    if (!candidate || scope.temporary || !scope.sessionId || preferences.doNotDisturb || !preferences.proactiveSpeechEnabled ||
      !voice || !process.env.VOLCENGINE_REALTIME_API_KEY || !process.env.VOLCENGINE_ARK_API_KEY || !process.env.VOLCENGINE_ARK_MODEL) return null
    const preferenceVersion = preferences.version, personaVersion = persona.version
    this.pending.delete(request.deliveryId); this.cancel(owner)
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000)
    this.active.set(owner, { requestId: request.requestId, controller })
    const check = (playback = false) => {
      const currentScope = this.options.scope(), policy = this.options.preferences()
      if ((!playback && controller.signal.aborted) || currentScope.temporary || currentScope.sessionId !== scope.sessionId ||
        policy.version !== preferenceVersion || policy.doNotDisturb || !policy.proactiveSpeechEnabled ||
        this.options.persona().version !== personaVersion || this.options.configurationRevision() !== revision || !candidate.valid()) throw new Error('NOTICE_REVOKED')
    }
    try {
      check()
      const input = structuredClone(candidate.input)
      const systemText = this.options.assets.compile('reminderDelivery', { persona_json: persona, reminder_delivery_json: input }).text
      const boundary: ArkModelBoundary = { systemText, assertCurrent: check,
        finalize() { check(); return { messages: [{ role: 'system', content: systemText },
          { role: 'user', content: JSON.stringify({ type: 'local_due_event', data: input }) }], tools: [] } },
        validateToolCall() { throw new Error('NOTICE_TOOLS_FORBIDDEN') } }
      const response = await this.options.provider.request({ boundary, messages: [], signal: controller.signal, maxOutputTokens: 2048 })
      check()
      const text = response.text.trim()
      if (!text || [...text].length > 500 || /https?:\/\/|```/.test(text) ||
        [input.deliveryId, input.reminderId, input.focusId].some(id => id && text.includes(id))) throw new Error('NOTICE_TEXT_INVALID')
      const context = { sessionId: scope.sessionId, sessionGeneration: 1, turnId: request.requestId, currentTime: new Date().toISOString(),
        timezone: input.timezone, temporary: false, contextVersion: 1, personaVersion, deletionEpoch: 0,
        selectedEntity: null, availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: [], memories: [], activeTasks: [] }
      const ttsBoundary = new R1ModelRequestBoundary(this.options.assets, persona, context, [], 'realtime', check, true)
      const audio = await this.options.synthesize({ text, voice, boundary: ttsBoundary, signal: controller.signal }); check()
      const wav = Buffer.from(audio)
      if (wav.length < 46 || wav.length > 2160044 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 36, 40) !== 'data' ||
        wav.readUInt32LE(24) !== 24000 || wav.readUInt16LE(22) !== 1 || wav.readUInt16LE(34) !== 16 ||
        wav.readUInt32LE(40) !== wav.length - 44 || (wav.length - 44) % 2) throw new Error('NOTICE_AUDIO_INVALID')
      const responseId = `reminder-delivery:${randomUUID()}`, ledger = new NativePlaybackLedger(this.options.conversations, scope.sessionId)
      ledger.receive({ type: 'response.output_text.done', response_id: responseId, text }, request.requestId)
      for (let offset = 44; offset < wav.length; offset += 48000) ledger.receive({ type: 'response.output_audio.delta',
        response_id: responseId, delta: wav.subarray(offset, offset + 48000).toString('base64') }, request.requestId)
      ledger.receive({ type: 'response.output_audio.done', response_id: responseId }, request.requestId)
      const expiry = setTimeout(() => this.cancel(owner, request.requestId), 60000); expiry.unref?.()
      this.playback.set(request.requestId, { owner, ledger, responseId, started: false, check: () => check(true), timer: expiry })
      return { responseId, text, audio, mimeType: 'audio/wav' }
    } finally {
      clearTimeout(timer); controller.abort()
      if (this.active.get(owner)?.requestId === request.requestId) this.active.delete(owner)
    }
  }
}
