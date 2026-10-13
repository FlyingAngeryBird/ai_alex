import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
import { R1ServiceDiagnostics } from '../electron/main/r1/serviceDiagnostics'
import { ArkResponsesError } from '../electron/main/providers/arkResponsesProvider'
import type { createArkResponsesProvider } from '../electron/main/providers/arkResponsesProvider'
import { NativeRealtimeError } from '../electron/main/providers/nativeRealtimeProvider'
import { loadR1PromptAssets } from '../electron/main/r1/promptAssets'
import type { CredentialVault } from '../electron/main/r1/credentials'
import type { R1PersonaStore } from '../electron/main/r1/persona'
const assets = loadR1PromptAssets(resolve('r1-assets'))
type RequestInput = Parameters<ReturnType<typeof createArkResponsesProvider>['request']>[0]
function fixture(request = vi.fn(async (_input: RequestInput) => ({ id: 'response', output: [], calls: [], text: '连接正常', usage: null }))) {
  const vault = { revision: 1 }
  const persona = { assistantName: '测试助手', userAddress: '', style: '简洁', voiceId: 'test_voice', version: 1 }
  const realtime = vi.fn(async () => ({ scope: 'session_create_close' as const, model: '1.2.6.1' }))
  const service = new R1ServiceDiagnostics(vault as CredentialVault, assets,
    { get: () => persona } as R1PersonaStore, { ark: { request }, realtime })
  return { service, request, vault, persona, realtime }
}
describe('service diagnostics isolation and cancellation', () => {
  it('uses isolated temporary context and zero tools; reports scope without returning body/secret', async () => {
    const { service, request } = fixture()
    const report = await service.check(1, { requestId: randomUUID(), service: 'ark' })
    expect(report).toMatchObject({ status: 'passed', scope: 'responses', configurationRevision: 1 })
    const input = request.mock.calls[0][0]
    expect(input.boundary.finalize([]).tools).toEqual([])
    expect(input.boundary.systemText).toContain('"temporary":true')
    expect(input.messages).toEqual([{ role: 'user', content: '连接测试，请简短回复。' }])
    expect(JSON.stringify(report)).not.toContain('连接正常')
    expect(report.durationMs).toBeGreaterThanOrEqual(0)
  })
  it('categorizes missing realtime config and never calls an ASR/TTS fallback', async () => {
    const { service, realtime, request } = fixture()
    realtime.mockRejectedValueOnce(new NativeRealtimeError('REALTIME_NOT_CONFIGURED'))
    expect(await service.check(1, { requestId: randomUUID(), service: 'realtime' }))
      .toMatchObject({ status: 'not_configured', code: 'REALTIME_NOT_CONFIGURED' })
    expect(request).not.toHaveBeenCalled()
  })
  it('drops late success after owner-scoped cancellation, credential or persona changes', async () => {
    for (const reason of ['cancel', 'credential', 'persona']) {
      let release!: () => void
      const pending = new Promise<void>(resolve => { release = resolve })
      const request = vi.fn(async (_input: RequestInput) => { await pending; return { id: 'x', output: [], calls: [], text: 'x', usage: null } })
      const { service, vault, persona } = fixture(request)
      const requestId = randomUUID()
      const promise = service.check(1, { requestId, service: 'ark' })
      service.cancel(2, requestId)
      if (reason === 'cancel') service.cancel(1, requestId)
      if (reason === 'credential') vault.revision++
      if (reason === 'persona') persona.version++
      release()
      expect(await promise).toMatchObject({ status: 'cancelled' })
    }
  })
  it('rejects overlapping checks, preserves active cancel ownership and sanitizes failures', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const request = vi.fn(async (_input: RequestInput) => { await pending; throw new Error('key=private-secret') })
    const { service } = fixture(request)
    const first = service.check(1, { requestId: randomUUID(), service: 'ark' })
    await expect(service.check(1, { requestId: randomUUID(), service: 'ark' })).rejects.toThrow('SERVICE_CHECK_BUSY')
    release()
    expect(await first).toMatchObject({ status: 'failed', code: 'SERVICE_CHECK_FAILED' })
    request.mockRejectedValueOnce(new ArkResponsesError('ARK_HTTP_429'))
    expect(await service.check(1, { requestId: randomUUID(), service: 'ark' }))
      .toMatchObject({ status: 'failed', code: 'ARK_HTTP_429' })
  })
})
