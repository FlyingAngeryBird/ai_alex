<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import type { R1Persona } from '../../electron/main/r1/persona'
import type { CredentialField, CredentialPatch, CredentialStatus } from '../../electron/main/r1/credentials'

const props = defineProps<{ persona: R1Persona | null; voicePreviewing: boolean }>()
const emit = defineEmits<{
  close: []
  saved: [persona: R1Persona]
  previewVoice: [voiceId: string]
  credentialsChanged: [status: CredentialStatus]
}>()

const assistantName = ref('Seamo AI')
const userAddress = ref('')
const style = ref('balanced')
const voiceId = ref('')
const busy = ref(false)
const message = ref('')
const credentialFields: { key: CredentialField; label: string; secret: boolean }[] = [
  { key: 'VOLCENGINE_ARK_API_KEY', label: '豆包 API Key', secret: true },
  { key: 'VOLCENGINE_ARK_MODEL', label: '豆包模型名', secret: false },
  { key: 'VOLCENGINE_ASR_APP_ID', label: '语音识别 App ID', secret: false },
  { key: 'VOLCENGINE_ASR_ACCESS_TOKEN', label: '语音识别 Access Token', secret: true },
  { key: 'VOLCENGINE_STREAM_ASR_API_KEY', label: '实时语音 API Key', secret: true },
  { key: 'VOLCENGINE_TTS_API_KEY', label: '语音合成 API Key', secret: true },
  { key: 'VOLCENGINE_TTS_VOICE', label: '默认音色 ID', secret: false },
  { key: 'BRAVE_SEARCH_API_KEY', label: 'Brave Search API Key · G0 待验证候选', secret: true }
]
const credentialInputs = reactive<Partial<Record<CredentialField, string>>>({})
const credentialStatus = ref<CredentialStatus | null>(null)

watch(() => props.persona, (current) => {
  if (!current) return
  assistantName.value = current.assistantName
  userAddress.value = current.userAddress
  style.value = current.style
  voiceId.value = current.voiceId
}, { immediate: true })

onMounted(async () => {
  try {
    const result = await window.seamoR1.credentials.status()
    if (result.ok) credentialStatus.value = result.data
    else message.value = '服务配置状态暂时无法读取。'
  } catch {
    message.value = '服务配置状态暂时无法读取。'
  }
})

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
        <h3>记忆与临时对话</h3>
        <p>自动记忆目前关闭。临时对话在输入框下方开启；临时内容不写入普通聊天历史。</p>
      </section>
      <section class="r1-settings-section">
        <h3>服务状态</h3>
        <p>对话模型：{{ credentialStatus?.VOLCENGINE_ARK_API_KEY && credentialStatus?.VOLCENGINE_ARK_MODEL ? '密钥与模型已填写，实际连接待请求验证' : '未配置' }}</p>
        <p>联网搜索：{{ credentialStatus?.BRAVE_SEARCH_API_KEY ? '候选服务已填写密钥，G0 待验证' : 'G0 待验证候选，未配置' }}</p>
        <p>音乐音源：待 G0 真实播放验证</p>
        <details><summary>模型与语音服务配置</summary>
          <p>密钥保存在本机加密存储中，这里不回显。留空不会覆盖原值。</p>
          <div v-for="field in credentialFields" :key="field.key" class="r1-settings-field">
            <label :for="`r1-${field.key}`">{{ field.label }}</label>
            <div class="r1-settings-credential-row">
              <input :id="`r1-${field.key}`" v-model="credentialInputs[field.key]"
                :type="field.secret ? 'password' : 'text'" autocomplete="off"
                :placeholder="credentialStatus?.[field.key] ? '已配置；输入可替换' : '尚未配置'" />
              <button v-if="credentialStatus?.[field.key]" type="button" :disabled="busy"
                :aria-label="`移除${field.label}`" @click="clearCredential(field.key)">移除</button>
            </div>
          </div>
          <button type="button" class="r1-settings-save" :disabled="busy" @click="saveCredentials">保存服务配置</button>
        </details>
      </section>
      <p v-if="message" class="r1-settings-message" role="status">{{ message }}</p>
    </div>
  </aside>
</template>
