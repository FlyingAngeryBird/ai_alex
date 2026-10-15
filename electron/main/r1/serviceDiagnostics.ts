import { randomUUID } from 'node:crypto'
import { createArkResponsesProvider, ArkResponsesError } from '../providers/arkResponsesProvider.js'
import { checkNativeRealtimeSession, NativeRealtimeError } from '../providers/nativeRealtimeProvider.js'
import { R1ModelRequestBoundary } from './modelBoundary.js'
import type { R1PromptAssets } from './promptAssets.js'
import type { CredentialVault } from './credentials.js'
import type { R1PersonaStore } from './persona.js'

export type ServiceCheckTarget = 'ark' | 'realtime'
export type ServiceCheckReport = {
  service: ServiceCheckTarget; status: 'passed' | 'not_configured' | 'failed' | 'cancelled';
  code: string; checkedAt: string; durationMs: number; configurationRevision: number;
  scope: 'responses' | 'session_create_close'
}
type CheckInput = { requestId: string; service: ServiceCheckTarget }
export class R1ServiceDiagnostics {
  private active = new Map<number, { requestId: string; controller: AbortController }>()
  private reports = new Map<ServiceCheckTarget, ServiceCheckReport>()
  latestReports(): ServiceCheckReport[] { return [...this.reports.values()].map(value => ({ ...value })) }
  constructor(private readonly vault: CredentialVault, private readonly assets: R1PromptAssets,
    private readonly persona: R1PersonaStore, private readonly deps: {
      ark?: ReturnType<typeof createArkResponsesProvider>;
      realtime?: typeof checkNativeRealtimeSession
    } = {}) {}

  async check(owner: number, input: CheckInput): Promise<ServiceCheckReport> {
    if (!input || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.requestId) ||
      !['ark', 'realtime'].includes(input.service)) throw new Error('SERVICE_CHECK_INPUT_INVALID')
    if (this.active.has(owner)) throw new Error('SERVICE_CHECK_BUSY')
    const controller = new AbortController()
    this.active.set(owner, { requestId: input.requestId, controller })
    const revision = this.vault.revision
    let personaVersion: number | undefined
    const start = performance.now()
    const report = (status: ServiceCheckReport['status'], code: string): ServiceCheckReport => {
      const value: ServiceCheckReport = { service: input.service, status, code, checkedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - start), configurationRevision: revision,
        scope: input.service === 'ark' ? 'responses' : 'session_create_close' }
      this.reports.set(input.service, value); return value
    }
    try {
      const context = { sessionId: randomUUID(), sessionGeneration: 1, turnId: randomUUID(),
        currentTime: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        temporary: true, contextVersion: 1, personaVersion: 1, deletionEpoch: 0, selectedEntity: null,
        availableToolAliases: [], loadedSkillIds: ['SK01'], recentTurns: [], memories: [], activeTasks: [] }
      const persona = this.persona.get()
      personaVersion = persona.version
      context.personaVersion = persona.version
      const boundary = new R1ModelRequestBoundary(this.assets, persona, context, [],
        input.service === 'realtime' ? 'realtime' : 'textOnly')
      if (input.service === 'ark') {
        await (this.deps.ark ?? createArkResponsesProvider()).request({ boundary,
          messages: [{ role: 'user', content: '连接测试，请简短回复。' }], signal: controller.signal, maxOutputTokens: 512 })
      } else {
        await (this.deps.realtime ?? checkNativeRealtimeSession)({ boundary,
          apiKey: process.env.VOLCENGINE_REALTIME_API_KEY ?? '',
          voice: persona.voiceId || process.env.VOLCENGINE_REALTIME_VOICE || '', signal: controller.signal })
      }
      if (this.vault.revision !== revision || this.persona.get().version !== personaVersion) return report('cancelled', 'SERVICE_CONFIG_CHANGED')
      if (controller.signal.aborted) return report('cancelled', 'SERVICE_CHECK_CANCELLED')
      return report('passed', 'SERVICE_CHECK_PASSED')
    } catch (error) {
      if (this.vault.revision !== revision) return report('cancelled', 'SERVICE_CONFIG_CHANGED')
      if (controller.signal.aborted) return report('cancelled', 'SERVICE_CHECK_CANCELLED')
      const code = error instanceof ArkResponsesError || error instanceof NativeRealtimeError
        ? error.code : 'SERVICE_CHECK_FAILED'
      return report(['ARK_NOT_CONFIGURED', 'REALTIME_NOT_CONFIGURED', 'REALTIME_VOICE_REQUIRED'].includes(code)
        ? 'not_configured' : 'failed', code)
    } finally { this.active.delete(owner) }
  }
  cancel(owner: number, requestId?: string): void {
    const current = this.active.get(owner)
    if (current && (!requestId || current.requestId === requestId)) current.controller.abort()
  }
  close(): void { for (const { controller } of this.active.values()) controller.abort() }
}
