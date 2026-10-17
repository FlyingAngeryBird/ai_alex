import type { CredentialStatus } from '../../electron/main/r1/credentials'
import type { R1Api } from '../../electron/shared/r1Api'
import { invokeWithTimeout } from '../utils/invokeWithTimeout'

export type VoiceMode = 'native' | 'pushToTalk'
export function voiceConfigurationError(mode: VoiceMode, status: CredentialStatus, personaVoice: string): string | null {
  if (mode === 'native') {
    if (!status.VOLCENGINE_REALTIME_API_KEY) return 'REALTIME_NOT_CONFIGURED'
    if (!personaVoice.trim() && !status.VOLCENGINE_REALTIME_VOICE) return 'REALTIME_VOICE_REQUIRED'
  } else if (!status.VOLCENGINE_STREAM_ASR_API_KEY &&
    !(status.VOLCENGINE_ASR_APP_ID && status.VOLCENGINE_ASR_ACCESS_TOKEN)) return 'REALTIME_ASR_NOT_CONFIGURED'
  return null
}
export function voiceConfigurationMessage(code: string): string | null {
  return ({ REALTIME_NOT_CONFIGURED: '请在设置中保存原生实时对话 3.0 API Key，再开启自动会话。',
    REALTIME_VOICE_REQUIRED: '请在设置中保存实时对话默认音色，或保存你的声音 ID，再开启自动会话。',
    REALTIME_CONFIG_INVALID: '实时对话配置格式不正确，请在设置中重新保存。',
    REALTIME_ASR_NOT_CONFIGURED: '按住说话需要单独配置语音识别（ASR）。若已配置原生实时对话，请点击下方「开启自动会话」；按住说话的配置可在设置中填写。',
    VOICE_CONFIGURATION_UNAVAILABLE: '暂时无法读取语音配置，尚未开启麦克风。请重试或在设置中检查。' } as Record<string, string>)[code] ?? null
}

/** Read local configuration only. Configured does not imply authenticated or connected. */
export async function checkVoiceReadiness(api: { credentials: Pick<R1Api['credentials'], 'status'>; persona: Pick<R1Api['persona'], 'get'> }, mode: VoiceMode): Promise<CredentialStatus> {
  const [credentials, persona] = await Promise.all([
    invokeWithTimeout(api.credentials.status(), 5000, 'VOICE_CONFIGURATION_UNAVAILABLE'),
    invokeWithTimeout(api.persona.get(), 5000, 'VOICE_CONFIGURATION_UNAVAILABLE')
  ])
  if (!credentials.ok || !persona.ok) throw new Error('VOICE_CONFIGURATION_UNAVAILABLE')
  const code = voiceConfigurationError(mode, credentials.data, persona.data.voiceId)
  if (code) throw new Error(code)
  return credentials.data
}
