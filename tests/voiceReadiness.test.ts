import { expect, it, vi } from 'vitest'
import type { CredentialStatus } from '../electron/main/r1/credentials'
import { checkVoiceReadiness, voiceConfigurationError } from '../src/services/voiceReadiness'

const status = (patch: Partial<CredentialStatus> = {}): CredentialStatus => ({
  VOLCENGINE_ARK_API_KEY: false, VOLCENGINE_ARK_MODEL: false, VOLCENGINE_REALTIME_API_KEY: false,
  VOLCENGINE_REALTIME_VOICE: false, VOLCENGINE_ASR_APP_ID: false, VOLCENGINE_ASR_ACCESS_TOKEN: false,
  VOLCENGINE_STREAM_ASR_API_KEY: false, VOLCENGINE_TTS_API_KEY: false, VOLCENGINE_TTS_VOICE: false,
  BRAVE_SEARCH_API_KEY: false, ...patch
})
it('does not mistake text model credentials for native voice credentials', () => {
  expect(voiceConfigurationError('native', status({ VOLCENGINE_ARK_API_KEY: true, VOLCENGINE_ARK_MODEL: true }), 'voice')).toBe('REALTIME_NOT_CONFIGURED')
  expect(voiceConfigurationError('native', status({ VOLCENGINE_REALTIME_API_KEY: true }), '')).toBe('REALTIME_VOICE_REQUIRED')
  expect(voiceConfigurationError('native', status({ VOLCENGINE_REALTIME_API_KEY: true }), 'persona_voice')).toBeNull()
  expect(voiceConfigurationError('native', status({ VOLCENGINE_REALTIME_API_KEY: true, VOLCENGINE_REALTIME_VOICE: true }), '')).toBeNull()
})
it('accepts the actual streaming ASR alternatives and rejects incomplete pairs or TTS-only keys', () => {
  expect(voiceConfigurationError('pushToTalk', status({ VOLCENGINE_STREAM_ASR_API_KEY: true }), '')).toBeNull()
  expect(voiceConfigurationError('pushToTalk', status({ VOLCENGINE_ASR_APP_ID: true, VOLCENGINE_ASR_ACCESS_TOKEN: true }), '')).toBeNull()
  for (const patch of [{ VOLCENGINE_ASR_APP_ID: true }, { VOLCENGINE_ASR_ACCESS_TOKEN: true }, { VOLCENGINE_TTS_API_KEY: true }]) {
    expect(voiceConfigurationError('pushToTalk', status(patch), '')).toBe('REALTIME_ASR_NOT_CONFIGURED')
  }
})
it('reads saved configuration again on each attempt and never performs a service request', async () => {
  const current = status({ VOLCENGINE_REALTIME_API_KEY: true, VOLCENGINE_REALTIME_VOICE: true })
  const credentials = { status: vi.fn(async () => ({ ok: true as const, data: { ...current } })) }
  const persona = { get: vi.fn(async () => ({ ok: true as const, data: { assistantName: 'Seamo', userAddress: '', style: '', voiceId: '', version: 1 } })) }
  await expect(checkVoiceReadiness({ credentials, persona }, 'native')).resolves.toEqual(current)
  current.VOLCENGINE_REALTIME_API_KEY = false
  await expect(checkVoiceReadiness({ credentials, persona }, 'native')).rejects.toThrow('REALTIME_NOT_CONFIGURED')
  expect(credentials.status).toHaveBeenCalledTimes(2)
})
it('treats a failed local read as unknown rather than permission to open the microphone', async () => {
  const api = { credentials: { status: async () => ({ ok: false as const, error: { code: 'INTERNAL', message: 'private error' } }) },
    persona: { get: async () => ({ ok: true as const, data: { assistantName: 'Seamo', userAddress: '', style: '', voiceId: '', version: 1 } }) } }
  await expect(checkVoiceReadiness(api, 'native')).rejects.toThrow('VOICE_CONFIGURATION_UNAVAILABLE')
})
