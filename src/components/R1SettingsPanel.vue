<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import type { AutomaticMemoryState } from '../../electron/main/r1/automaticMemory'
import type { MemoryPolicy } from '../../electron/main/r1/memoryPolicy'
import type { R1Persona } from '../../electron/main/r1/persona'
import type { CredentialField, CredentialPatch, CredentialStatus } from '../../electron/main/r1/credentials'
import type { ServiceCheckReport, ServiceCheckTarget } from '../../electron/main/r1/serviceDiagnostics'
import { useAppPreferences } from '../composables/useAppPreferences'
import type { createAudioDevices } from '../services/audioDevices'
import R1DataSettings from './R1DataSettings.vue'

const props = defineProps<{ persona: R1Persona | null; voicePreviewing: boolean; devices?: ReturnType<typeof createAudioDevices>; systemReducedMotion?: boolean; diagnosticTrace?: () => unknown; showServiceConfiguration?: boolean; serviceConfigurationField?: CredentialField;
  nativeDiagnostics?: () => ReturnType<ReturnType<typeof import('../composables/useNativeConversation').useNativeConversation>['getDiagnostics']> }>()
const nativeSnapshot = ref<ReturnType<NonNullable<typeof props.nativeDiagnostics>> | null>(null)
const serviceConfiguration = ref<HTMLDetailsElement | null>(null)
async function revealServiceConfiguration(): Promise<void> {
  if (!props.showServiceConfiguration) return
  await nextTick()
  if (!serviceConfiguration.value) return
  serviceConfiguration.value.open = true
  await nextTick()
  serviceConfiguration.value.querySelector<HTMLInputElement>(`#r1-${props.serviceConfigurationField ?? 'VOLCENGINE_ARK_API_KEY'}`)?.focus()
}
onMounted(revealServiceConfiguration)
watch(() => props.showServiceConfiguration, revealServiceConfiguration)
const preferences = useAppPreferences()
const permissionBusy = ref(false)
let permissionAbort: AbortController | null = null
onBeforeUnmount(() => permissionAbort?.abort())
const outputSelectionSupported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype &&
  typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype
onMounted(() => { void preferences.load() })
async function toggleQuiet(key: 'doNotDisturb' | 'proactiveSpeechEnabled' | 'reducedMotion', event: Event): Promise<void> {
  const checkbox = event.target as HTMLInputElement, enabled = checkbox.checked
  checkbox.checked = preferences.value.value?.[key] ?? false
  await preferences.update({ [key]: enabled })
}
async function selectDevice(key: 'inputDeviceId' | 'outputDeviceId', event: Event): Promise<void> {
  const select = event.target as HTMLSelectElement, selected = select.value || null
  select.value = preferences.value.value?.[key] ?? ''
  await preferences.update({ [key]: selected })
}
async function requestDevicePermission(): Promise<void> {
  if (!props.devices || permissionBusy.value) return
  permissionBusy.value = true
  permissionAbort = new AbortController()
  try {
    const result = await window.lingli.invoke<{ granted: boolean }>('app.requestMicrophoneAccess')
    if (disposed) return
    if (!result.ok || !result.data.granted) { props.devices.error.value = '麦克风权限未开启。可在系统隐私设置授权；文字仍可使用。'; return }
    await props.devices.requestPermission(permissionAbort.signal)
  } catch { props.devices.error.value = '设备授权未完成，请稍后重试。' }
  finally { permissionBusy.value = false }
}
const emit = defineEmits<{
  close: []
  saved: [persona: R1Persona]
  previewVoice: [voiceId: string]
  credentialsChanged: [status: CredentialStatus]
  openHistory: []
  showWelcome: []
}>()

const assistantName = ref('Seamo AI')
const userAddress = ref('')
const style = ref('balanced')
const voiceId = ref('')
const busy = ref(false)
const message = ref('')
const memoryPolicy = ref<(MemoryPolicy & AutomaticMemoryState) | null>(null)
const memoryPolicyBusy = ref(false)
const memoryPolicyError = ref('')
let stopMemoryPolicy: (() => void) | null = null
onMounted(async () => {
  stopMemoryPolicy = window.seamoR1.memory.onPolicyChanged(value => { if (!disposed) memoryPolicy.value = value })
  try {
    const result = await window.seamoR1.memory.policy()
    if (!disposed) { if (result.ok) memoryPolicy.value = result.data; else memoryPolicyError.value = '记忆设置暂时无法读取。' }
  } catch { if (!disposed) memoryPolicyError.value = '记忆设置暂时无法读取。' }
})
onBeforeUnmount(() => stopMemoryPolicy?.())
async function toggleAutomaticMemory(event: Event): Promise<void> {
  const checkbox = event.target as HTMLInputElement
  const policy = memoryPolicy.value
  const enabled = checkbox.checked
  checkbox.checked = policy?.enabled ?? false
  if (!policy || memoryPolicyBusy.value) return
  memoryPolicyBusy.value = true; memoryPolicyError.value = ''
  try {
    const result = await window.seamoR1.memory.setPolicy({ enabled, expectedVersion: policy.version })
    if (disposed) return
    if (result.ok) memoryPolicy.value = result.data
    else {
      memoryPolicyError.value = result.error.code === 'VERSION_CONFLICT' ? '设置已有变化，已重新读取，请再试一次。' : '设置未保存，请重试。'
      const current = await window.seamoR1.memory.policy()
      if (!disposed && current.ok) memoryPolicy.value = current.data
    }
  } catch { if (!disposed) memoryPolicyError.value = '设置未保存，请重试。' }
  finally { memoryPolicyBusy.value = false }
}
const credentialFields: { key: CredentialField; label: string; secret: boolean }[] = [
  { key: 'VOLCENGINE_ARK_API_KEY', label: '豆包 API Key', secret: true },
  { key: 'VOLCENGINE_ARK_MODEL', label: '豆包模型名', secret: false },
  { key: 'VOLCENGINE_REALTIME_API_KEY', label: '原生实时对话 3.0 API Key', secret: true },
  { key: 'VOLCENGINE_REALTIME_VOICE', label: '原生实时对话默认音色 ID', secret: false },
  { key: 'VOLCENGINE_ASR_APP_ID', label: '语音识别 App ID', secret: false },
  { key: 'VOLCENGINE_ASR_ACCESS_TOKEN', label: '语音识别 Access Token', secret: true },
  { key: 'VOLCENGINE_STREAM_ASR_API_KEY', label: '流式 ASR API Key', secret: true },
  { key: 'VOLCENGINE_TTS_API_KEY', label: '语音合成 API Key', secret: true },
  { key: 'VOLCENGINE_TTS_VOICE', label: '默认音色 ID', secret: false },
  { key: 'DOUBAO_SEARCH_API_KEY', label: '豆包搜索 Custom API Key', secret: true }
]
const credentialInputs = reactive<Partial<Record<CredentialField, string>>>({})
const credentialStatus = ref<CredentialStatus | null>(null)
const credentialLoading = ref(false)
const checks = reactive<Partial<Record<ServiceCheckTarget, ServiceCheckReport>>>({})
const checking = ref<ServiceCheckTarget | null>(null)
let checkRequestId: string | null = null
let configurationGeneration = 0
let disposed = false
function cancelCheck(): void {
  if (checkRequestId) void window.seamoR1.services.cancel(checkRequestId).catch(() => {})
}
function invalidateChecks(): void {
  configurationGeneration++
  delete checks.ark
  delete checks.realtime
  if (checkRequestId) void window.seamoR1.services.cancel(checkRequestId).catch(() => {})
}
onBeforeUnmount(() => { disposed = true; invalidateChecks() })
watch(() => props.persona?.version, (next, previous) => { if (previous !== undefined && next !== previous) invalidateChecks() })
async function checkService(service: ServiceCheckTarget): Promise<void> {
  if (checking.value || busy.value) return
  if (!credentialStatus.value) { message.value = '请先重新读取服务配置；凭据不可读时不发起云端检测。'; return }
  const generation = configurationGeneration
  const requestId = crypto.randomUUID()
  checkRequestId = requestId
  checking.value = service
  message.value = ''
  try {
    const result = await window.seamoR1.services.check({ service, requestId })
    if (disposed || generation !== configurationGeneration) return
    if (result.ok) checks[service] = result.data
    else message.value = '连接检测未能启动，请稍后重试。'
  } catch { if (!disposed) message.value = '连接检测暂时不可用。' }
  finally { if (checkRequestId === requestId) { checkRequestId = null; checking.value = null } }
}
function checkLabel(report?: ServiceCheckReport): string {
  if (!report) return '尚未检测'
  if (report.status === 'passed') return report.service === 'ark' ? '请求通过' : '会话建立与关闭通过'
  if (report.status === 'cancelled') return '已取消，请重新检测'
  if (report.status === 'not_configured') return report.service === 'ark' ? '请先保存密钥与模型' : '请先保存密钥与音色'
  if (report.code === 'REALTIME_AUTH_FAILED') return '鉴权未通过：请检查豆包语音 Key、所属项目与实时对话开通权限'
  if (['ARK_HTTP_401', 'ARK_HTTP_403'].includes(report.code)) return '鉴权失败，请检查密钥与服务权限'
  if (['REALTIME_QUOTA_LIMIT', 'ARK_HTTP_429'].includes(report.code)) return '服务限额，请稍后重试'
  if (report.code.includes('TIMEOUT')) return '连接超时，请重试'
  return '检测失败，请检查服务配置后重试'
}

watch(() => props.persona, (current) => {
  if (!current) return
  assistantName.value = current.assistantName
  userAddress.value = current.userAddress
  style.value = current.style
  voiceId.value = current.voiceId
}, { immediate: true })

async function refreshCredentials(): Promise<void> {
  if (credentialLoading.value) return
  credentialLoading.value = true
  try {
    const result = await window.seamoR1.credentials.status()
    if (disposed) return
    if (result.ok) { credentialStatus.value = result.data; emit('credentialsChanged', result.data); message.value = ''; invalidateChecks() }
    else { credentialStatus.value = null; message.value = result.error.code === 'SYSTEM_SECRET_STORAGE_UNAVAILABLE'
      ? '系统钥匙串暂时不可用。请手动解锁 login 钥匙串后重试；已保存的加密配置保留。'
      : '服务配置暂时无法解密。加密文件保留，未覆盖；请检查系统安全存储后重试。' }
  } catch {
    if (!disposed) message.value = '服务配置状态暂时无法读取。'
  } finally { credentialLoading.value = false }
}
onMounted(refreshCredentials)

async function savePersona(): Promise<void> {
  if (!props.persona || busy.value) return
  busy.value = true
  message.value = ''
  try {
    const result = await window.seamoR1.persona.update({
      expectedVersion: props.persona.version,
      assistantName: assistantName.value,
      userAddress: userAddress.value,
      style: style.value,
      voiceId: voiceId.value
    })
    if (!result.ok) {
      message.value = result.error.code === 'VERSION_CONFLICT'
        ? '设置已在别处更新，请关闭后重新打开再保存。'
        : '保存失败：请检查助手名、称呼和表达偏好的长度。'
      return
    }
    emit('saved', result.data)
    invalidateChecks()
    message.value = '偏好已保存；下一轮回复会使用新版本。'
  } catch {
    message.value = '保存失败：设置服务暂时不可用。'
  } finally {
    busy.value = false
  }
}

async function saveCredentials(): Promise<void> {
  if (busy.value) return
  const patch: CredentialPatch = {}
  for (const field of credentialFields) {
    const value = credentialInputs[field.key]?.trim()
    if (value) patch[field.key] = value
  }
  if (!Object.keys(patch).length) {
    message.value = '请填写要更新的服务配置。'
    return
  }
  busy.value = true
  try {
    const result = await window.seamoR1.credentials.save(patch)
    if (!result.ok) {
      message.value = '服务配置保存失败，请检查系统安全存储。'
      return
    }
    credentialStatus.value = result.data
    invalidateChecks()
    for (const field of credentialFields) credentialInputs[field.key] = ''
    emit('credentialsChanged', result.data)
    message.value = '服务配置已保存；是否可用仍以实际请求为准。'
  } catch {
    message.value = '服务配置保存失败，请检查系统安全存储。'
  } finally {
    busy.value = false
  }
}

async function clearCredential(field: CredentialField): Promise<void> {
  if (busy.value || !credentialStatus.value?.[field]) return
  busy.value = true
  try {
    const result = await window.seamoR1.credentials.save({ [field]: null })
    if (!result.ok) {
      message.value = '移除失败，请重试。'
      return
    }
    credentialStatus.value = result.data
    invalidateChecks()
    credentialInputs[field] = ''
    emit('credentialsChanged', result.data)
    message.value = '已移除这项服务配置。'
  } catch {
    message.value = '移除失败，请重试。'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <aside class="r1-basic-side r1-settings" aria-label="偏好设置">
    <header><div><small>SEAMO / PERSONAL SPACE</small><h2>偏好设置</h2></div>
      <button type="button" aria-label="关闭侧栏" @click="emit('close')"><X :size="19" /></button></header>
    <div class="r1-basic-content">
      <button type="button" class="r1-welcome-link" @click="emit('showWelcome')">查看首次使用说明</button>
      <section class="r1-settings-section">
        <h3>与你交流的方式</h3>
        <label for="r1-assistant-name">助手称呼</label>
        <input id="r1-assistant-name" v-model="assistantName" maxlength="20" autocomplete="off" />
        <label for="r1-user-address">对你的称呼</label>
        <input id="r1-user-address" v-model="userAddress" maxlength="20" placeholder="留空则不使用固定称呼" autocomplete="off" />
        <label for="r1-voice-id">声音 ID</label>
        <div class="r1-settings-voice"><input id="r1-voice-id" v-model="voiceId" maxlength="200"
          placeholder="留空使用服务默认音色" autocomplete="off" />
          <button type="button" :disabled="voicePreviewing || !voiceId.trim()"
            @click="emit('previewVoice', voiceId.trim())">{{ voicePreviewing ? '试听中' : '试听' }}</button></div>
        <details><summary>更细的表达方式</summary>
          <label for="r1-style">表达偏好</label>
          <textarea id="r1-style" v-model="style" maxlength="2000" rows="4" />
        </details>
        <button type="button" class="r1-settings-save" :disabled="busy || !persona" @click="savePersona">保存偏好</button>
      </section>
      <section class="r1-settings-section">
        <details><summary>设备与安静模式</summary>
          <div class="setting-line"><div><strong>勿扰</strong><small>暂停主动语音，提醒静默保留</small></div>
            <label class="switch"><input type="checkbox" aria-label="勿扰" :checked="preferences.value.value?.doNotDisturb ?? false" :disabled="!preferences.value.value || preferences.busy.value" @change="toggleQuiet('doNotDisturb', $event)" /><span /></label></div>
          <div class="setting-line"><div><strong>主动语音</strong><small>允许自动问候和主动播报</small></div>
            <label class="switch"><input type="checkbox" aria-label="主动语音" :checked="preferences.value.value?.proactiveSpeechEnabled ?? false" :disabled="!preferences.value.value || preferences.busy.value" @change="toggleQuiet('proactiveSpeechEnabled', $event)" /><span /></label></div>
          <p>关闭主动语音不会删除提醒或任务结果。你发起的交流与音色试听仍可出声。</p>
          <template v-if="devices">
            <label for="r1-input-device">输入设备</label>
            <select id="r1-input-device" :value="preferences.value.value?.inputDeviceId ?? ''" :disabled="!preferences.value.value || preferences.busy.value" @change="selectDevice('inputDeviceId', $event)">
              <option value="">系统默认麦克风</option>
              <option v-if="preferences.value.value?.inputDeviceId && !devices.inputs.value.some(device => device.deviceId === preferences.value.value?.inputDeviceId)" :value="preferences.value.value.inputDeviceId">已保存的设备（当前不可用）</option>
              <option v-for="(device, index) in devices.inputs.value.filter(device => device.deviceId)" :key="device.deviceId" :value="device.deviceId">{{ device.label || `麦克风 ${index + 1}` }}</option>
            </select>
            <label for="r1-output-device">输出设备</label>
            <select id="r1-output-device" :value="preferences.value.value?.outputDeviceId ?? ''" :disabled="!preferences.value.value || preferences.busy.value || !outputSelectionSupported" @change="selectDevice('outputDeviceId', $event)">
              <option value="">系统默认输出</option>
              <option v-if="preferences.value.value?.outputDeviceId && !devices.outputs.value.some(device => device.deviceId === preferences.value.value?.outputDeviceId)" :value="preferences.value.value.outputDeviceId">已保存的设备（当前不可用）</option>
              <option v-for="(device, index) in devices.outputs.value.filter(device => device.deviceId)" :key="device.deviceId" :value="device.deviceId">{{ device.label || `输出设备 ${index + 1}` }}</option>
            </select>
            <p v-if="!outputSelectionSupported">当前运行环境不支持指定输出设备，请在系统声音设置中选择。</p>
            <button v-if="preferences.value.value?.outputDeviceId" type="button" :disabled="preferences.busy.value" @click="preferences.update({ outputDeviceId: null })">恢复系统默认输出</button>
            <div class="r1-settings-check"><button type="button" :disabled="permissionBusy" @click="requestDevicePermission">{{ permissionBusy ? '授权中…' : '授权并刷新设备' }}</button><button type="button" :disabled="devices.refreshing.value" @click="devices.refresh">刷新列表</button></div>
            <p>只有主动开启语音时才持续收音。授权刷新会短暂打开并释放麦克风；切换输入设备会停止当前收音，重新开启后生效。</p>
            <p v-if="devices.error.value" role="alert">{{ devices.error.value }}</p>
            <p v-else-if="devices.routingActive.value" role="status">正在切换输出设备…</p>
          </template>
          <p v-if="preferences.error.value" role="alert">{{ preferences.error.value }}</p>
        </details>
      </section>
      <section class="r1-settings-section">
        <h3>记忆与感受</h3>
        <div class="setting-line"><div><strong>记住重要的事</strong><small>自动记忆 · {{ memoryPolicy ? (memoryPolicy.enabled ? '已开启' : '未开启') : '正在读取' }}</small></div>
          <label class="switch"><input type="checkbox" aria-label="设置自动记忆" :checked="memoryPolicy?.enabled ?? false"
            :disabled="!memoryPolicy || memoryPolicyBusy" @change="toggleAutomaticMemory" /><span /></label></div>
        <p>开启后，从接下来的普通对话中提取明确事实。敏感内容由你选择并单独确认；临时对话不读取或自动保存记忆。</p>
        <p>关闭会停止待处理的提取，已保存的记忆仍可查看、更正或忘记。</p>
        <p v-if="memoryPolicy?.state === 'processing'" role="status">正在整理这一轮明确的信息…</p>
        <p v-else-if="memoryPolicy?.state === 'failed' || memoryPolicy?.state === 'unavailable'" role="status">这次自动整理未完成，记忆页只显示已保存的内容。请检查对话服务配置。</p>
        <p v-if="memoryPolicyError" role="alert">{{ memoryPolicyError }}</p>
        <div class="setting-line"><div><strong>减弱音乐动态</strong><small>保留粒子球的基础呼吸</small></div>
          <label class="switch"><input type="checkbox" aria-label="减弱音乐动态" :checked="preferences.value.value?.reducedMotion ?? false" :disabled="!preferences.value.value || preferences.busy.value" @change="toggleQuiet('reducedMotion', $event)" /><span /></label></div>
        <p>只减弱视觉变化，音频和歌词照常运行。</p>
        <p v-if="systemReducedMotion">系统已开启减少动态，当前界面会遵循系统设置。</p>
        <p v-if="preferences.error.value" role="alert">{{ preferences.error.value }}</p>
      </section>
      <section class="r1-settings-section">
        <h3>服务状态</h3>
        <p v-if="!credentialStatus" role="status">服务配置{{ credentialLoading ? '读取中…' : '暂时不可读；已保存文件保留' }}</p>
        <button v-if="!credentialStatus" type="button" :disabled="credentialLoading || busy" @click="refreshCredentials">{{ credentialLoading ? '读取中…' : '重新读取服务配置' }}</button>
        <p v-if="credentialStatus">对话模型：{{ credentialStatus.VOLCENGINE_ARK_API_KEY && credentialStatus.VOLCENGINE_ARK_MODEL ? '密钥与模型已填写，实际连接待请求验证' : '未配置' }}</p>
        <p v-if="credentialStatus">原生实时对话 3.0：{{ credentialStatus.VOLCENGINE_REALTIME_API_KEY && (persona?.voiceId || credentialStatus.VOLCENGINE_REALTIME_VOICE) ? '密钥与音色已填写，实际连接待请求验证' : '未配置完整：需要密钥与音色' }}</p>
        <div class="r1-settings-check"><button type="button" :disabled="busy || !!checking" @click="checkService('ark')">{{ checking === 'ark' ? '检测中…' : '检测对话模型' }}</button><span role="status">{{ checkLabel(checks.ark) }}</span></div>
        <div class="r1-settings-check"><button type="button" :disabled="busy || !!checking" @click="checkService('realtime')">{{ checking === 'realtime' ? '检测中…' : '检测实时对话' }}</button><span role="status">{{ checkLabel(checks.realtime) }}</span></div>
        <p v-if="checks.realtime?.details" role="status">{{ checks.realtime.details.phase === 'http_upgrade' ? '连接握手阶段' : '会话阶段' }}<template v-if="checks.realtime.details.httpStatus"> · HTTP {{ checks.realtime.details.httpStatus }}</template><template v-if="checks.realtime.details.providerCode"> · 服务码 {{ checks.realtime.details.providerCode }}</template><template v-if="checks.realtime.details.reason === 'resource_not_granted'"> · 服务返回资源未授权</template><template v-if="checks.realtime.details.reason === 'key_invalid'"> · 服务返回 Key 无效</template></p>
        <button v-if="checking" type="button" @click="cancelCheck">取消检测</button>
        <p>检测使用已保存配置。实时检测只建立并关闭会话，不打开麦克风；连续交流和出声效果另行验证。</p>
        <details v-if="nativeDiagnostics"><summary>本次连续语音诊断</summary>
          <button type="button" @click="nativeSnapshot = nativeDiagnostics()">刷新语音诊断</button>
          <template v-if="nativeSnapshot">
            <p>采集 {{ nativeSnapshot.capturedFrames }} 包 · 已发送 {{ nativeSnapshot.sentFrames }} 包</p>
            <p>音频事件 {{ nativeSnapshot.rawAudioEvents }} · 接收 {{ nativeSnapshot.receivedAudioBytes }} 字节 · 峰值 {{ nativeSnapshot.audioPeak }}</p>
            <p>服务音频 {{ nativeSnapshot.serverAudioFrames }} 包 / {{ nativeSnapshot.serverAudioBytes }} 字节 · 服务端旧回复隔离 {{ nativeSnapshot.discardedCancelledAudio }} 包</p>
            <p>开始播放 {{ nativeSnapshot.playbackStarts }} 次 · 完成 {{ nativeSnapshot.playbackCompletions }} 次 · 已播放 {{ nativeSnapshot.playedUntilMs }} ms</p>
            <p>缓冲耗尽 {{ nativeSnapshot.playbackUnderruns }} 次（含句尾等待） · 耗尽后恢复播放 {{ nativeSnapshot.playbackRebuffers }} 次</p>
            <p>清空队列 {{ nativeSnapshot.clearRequests }} 次 · 已确认 {{ nativeSnapshot.clearAcks }} 次 · 超时 {{ nativeSnapshot.clearTimeouts }} 次 · 最长确认 {{ nativeSnapshot.maxClearAckMs }} ms · 重建连接 {{ nativeSnapshot.connectionRebuilds }} 次</p>
            <p>音频上下文 {{ nativeSnapshot.audioContextState }} · 缺回复标识 {{ nativeSnapshot.audioMissingResponseId }} · 已取消音频 {{ nativeSnapshot.audioDiscardedCancelled }}</p>
            <p>识别结束 {{ nativeSnapshot.asrCompleted }} · 含原文 {{ nativeSnapshot.asrWithTranscript }} · 含消息标识 {{ nativeSnapshot.asrWithItemId }} · 含text {{ nativeSnapshot.asrWithText }} · 含results {{ nativeSnapshot.asrWithResults }}</p>
            <p>服务识别增量 {{ nativeSnapshot.serverAsrDeltas }} · 结束 {{ nativeSnapshot.serverAsrCompleted }} · 含原文 {{ nativeSnapshot.serverAsrWithTranscript }} · 含消息标识 {{ nativeSnapshot.serverAsrWithItemId }}</p>
            <p v-if="nativeSnapshot.lastError">{{ nativeSnapshot.lastError }}</p>
          </template>
          <p>仅在本地显示计数与播放进度，不记录原始音频、识别正文或密钥。</p>
        </details>
        <p v-if="credentialStatus">联网搜索：豆包搜索 Custom · {{ credentialStatus.DOUBAO_SEARCH_API_KEY ? '密钥已填写，实际搜索待验证' : '未配置' }}</p>
        <p>音乐音源：待 G0 真实播放验证</p>
        <details ref="serviceConfiguration"><summary>模型与语音服务配置</summary>
          <p>密钥保存在本机加密存储中，这里不回显。留空不会覆盖原值。原生实时对话与 ASR、TTS 使用独立配置。</p>
          <p>实时对话 Key 来自豆包语音新版控制台的「API Key 管理」。请确认该 Key 所属项目已开通实时对话；火山方舟 Key 和旧版 Access Token 不能直接填写到此项。保存后点击「检测实时对话」验证连接。</p>
          <p>豆包搜索 Custom 使用「联网搜索控制台 → API Key 管理」创建的搜索专用 Key。请选择对应的订阅套餐或按量后付费 Key；它与上面的豆包模型 Key、实时语音 Key 分开配置。</p>
          <div v-for="field in credentialFields" :key="field.key" class="r1-settings-field">
            <label :for="`r1-${field.key}`">{{ field.label }}</label>
            <div class="r1-settings-credential-row">
              <input :id="`r1-${field.key}`" v-model="credentialInputs[field.key]"
                :type="field.secret ? 'password' : 'text'" autocomplete="off"
                :placeholder="!credentialStatus ? '状态不可读，原配置保留' : credentialStatus[field.key] ? '已配置；输入可替换' : '尚未配置'" />
              <button v-if="credentialStatus?.[field.key]" type="button" :disabled="busy"
                :aria-label="`移除${field.label}`" @click="clearCredential(field.key)">移除</button>
            </div>
          </div>
          <button type="button" class="r1-settings-save" :disabled="busy || !credentialStatus" @click="saveCredentials">保存服务配置</button>
        </details>
      </section>
      <p v-if="message" class="r1-settings-message" role="status">{{ message }}</p>
      <R1DataSettings :diagnostic-trace="diagnosticTrace" @open-history="emit('openHistory')" />
    </div>
  </aside>
</template>

<style scoped>
.r1-settings-section select { width: 100%; min-height: 34px; padding: 7px 9px; background: #1b2422; color: var(--r1-text); border: 1px solid var(--r1-line); border-radius: 5px; font: inherit; }
.r1-settings-check { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-size: 11px; line-height: 1.6; }
.r1-settings-check button { flex-shrink: 0; min-height: 30px; padding: 4px 9px; border: 1px solid var(--r1-line); border-radius: 5px; background: #1b2422; color: var(--r1-aqua); font: inherit; }
.r1-settings-check button:disabled { opacity: .45; }
.r1-settings-check span { color: #91a09b; }
.setting-line { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 0; }
.setting-line strong { display: block; font-size: 12px; font-weight: 400; color: #c1cbbd; }
.setting-line small { display: block; font-size: 10px; color: #6b806e; line-height: 1.8; margin-top: 4px; }
.r1-settings-section .switch { position: relative; display: inline-flex; flex-shrink: 0; width: 34px; height: 20px; cursor: pointer; }
.r1-settings-section .switch input { position: absolute; width: 100%; height: 100%; min-height: 0; padding: 0; margin: 0; opacity: 0; cursor: pointer; z-index: 1; }
.switch > span { position: absolute; inset: 0; border-radius: 20px; background: #303b33; border: 1px solid #4b5b4e; transition: background 180ms; }
.switch > span::before { content: ''; position: absolute; width: 12px; height: 12px; top: 3px; left: 3px; background: #87988b; border-radius: 50%; transition: transform 180ms; }
.switch input:checked + span { background: #80aa95; border-color: #98c6af; }
.switch input:checked + span::before { transform: translateX(14px); background: #183326; }
.switch input:focus-visible + span { outline: 2px solid var(--r1-gold); outline-offset: 4px; }
.switch input:disabled + span { opacity: .45; }
</style>
