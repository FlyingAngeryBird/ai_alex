<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import type { AppConfig, ConfigPatch, VoiceOption } from '@/types/app'
import type { CredentialField, CredentialPatch, CredentialStatus } from '../../electron/main/r1/credentials'

const props = defineProps<{
  config: AppConfig
  voicePreviewing: boolean
}>()

const emit = defineEmits<{
  close: []
  previewVoice: [voiceId: string]
  save: [patch: ConfigPatch]
}>()

const systemPrompt = ref(props.config.persona.systemPrompt)
const voices = reactive<VoiceOption[]>([])
const activeVoiceId = ref(props.config.voice.activeVoiceId)
const newVoiceName = ref('')
const newVoiceId = ref('')
const credentialFields: { key: CredentialField; label: string; secret: boolean }[] = [
  { key: 'VOLCENGINE_ARK_API_KEY', label: '豆包 API Key', secret: true },
  { key: 'VOLCENGINE_ARK_MODEL', label: '豆包模型名', secret: false },
  { key: 'VOLCENGINE_ASR_APP_ID', label: '语音识别 App ID', secret: false },
  { key: 'VOLCENGINE_ASR_ACCESS_TOKEN', label: '语音识别 Access Token', secret: true },
  { key: 'VOLCENGINE_STREAM_ASR_API_KEY', label: '实时语音 API Key', secret: true },
  { key: 'VOLCENGINE_TTS_API_KEY', label: '语音合成 API Key', secret: true },
  { key: 'VOLCENGINE_TTS_VOICE', label: '默认音色 ID', secret: false },
  { key: 'BRAVE_SEARCH_API_KEY', label: 'Brave Search API Key（G0 待验证候选）', secret: true }
]
const credentialInputs = reactive<Partial<Record<CredentialField, string>>>({})
const credentialStatus = ref<CredentialStatus | null>(null)
const credentialMessage = ref('')
const credentialsBusy = ref(false)

onMounted(async () => {
  if (!window.seamoR1) return
  const result = await window.seamoR1.credentials.status()
  if (result.ok) credentialStatus.value = result.data
})

async function saveCredentials(): Promise<void> {
  if (!window.seamoR1 || credentialsBusy.value) return
  const patch: CredentialPatch = {}
  for (const field of credentialFields) {
    const value = credentialInputs[field.key]?.trim()
    if (value) patch[field.key] = value
  }
  if (!Object.keys(patch).length) {
    credentialMessage.value = '请填写要更新的配置。'
    return
  }
  credentialsBusy.value = true
  const result = await window.seamoR1.credentials.save(patch)
  credentialsBusy.value = false
  if (!result.ok) {
    credentialMessage.value = '保存失败，请检查系统安全存储是否可用。'
    return
  }
  credentialStatus.value = result.data
  for (const field of credentialFields) credentialInputs[field.key] = ''
  credentialMessage.value = '服务配置已安全保存，新请求会使用最新设置。'
}

async function clearCredential(field: CredentialField): Promise<void> {
  if (!window.seamoR1 || credentialsBusy.value) return
  credentialsBusy.value = true
  const result = await window.seamoR1.credentials.save({ [field]: null })
  credentialsBusy.value = false
  if (result.ok) {
    credentialStatus.value = result.data
    credentialInputs[field] = ''
    credentialMessage.value = '已移除这项服务配置。'
  } else credentialMessage.value = '移除失败，请重试。'
}

function syncFromConfig(config: AppConfig): void {
  systemPrompt.value = config.persona.systemPrompt
  activeVoiceId.value = config.voice.activeVoiceId
  voices.splice(
    0,
    voices.length,
    ...config.voice.voices.map((voice) => ({ id: voice.id, name: voice.name }))
  )
}

watch(() => props.config, (next) => syncFromConfig(next), { immediate: true })

function addVoice(): void {
  const name = newVoiceName.value.trim()
  const id = newVoiceId.value.trim()

  if (!name || !id) {
    return
  }

  voices.push({ id, name })

  if (!activeVoiceId.value) {
    activeVoiceId.value = id
  }

  newVoiceName.value = ''
  newVoiceId.value = ''
}

function removeVoice(index: number): void {
  const removed = voices[index]

  voices.splice(index, 1)

  if (removed && activeVoiceId.value === removed.id) {
    activeVoiceId.value = voices[0]?.id ?? ''
  }
}

function close(): void {
  emit('close')
}

function previewVoice(): void {
  emit('previewVoice', activeVoiceId.value.trim())
}

function save(): void {
  emit('save', {
    persona: { systemPrompt: systemPrompt.value },
    voice: {
      voices: voices.map((voice) => ({ id: voice.id.trim(), name: voice.name.trim() })),
      activeVoiceId: activeVoiceId.value.trim()
    }
  })
  emit('close')
}
</script>

<template>
  <div class="settings-overlay" @click.self="close">
    <div class="settings-panel">
      <header class="settings-header">
        <h2>设置</h2>
        <button class="panel-toggle" type="button" @click="close">关闭</button>
      </header>

      <div class="settings-body">
        <section class="settings-section">
          <label class="settings-label">音色</label>
          <p class="settings-hint">火山引擎 voiceId，可配置多个便于快速切换。当前音色留空则使用下方服务配置的默认值。</p>

          <div class="voice-row">
            <select v-model="activeVoiceId" class="settings-input">
              <option value="">（默认音色）</option>
              <option v-for="voice in voices" :key="voice.id" :value="voice.id">{{ voice.name }}</option>
            </select>
            <button
              class="icon-text-button"
              type="button"
              :disabled="voicePreviewing || !activeVoiceId"
              @click="previewVoice"
            >
              {{ voicePreviewing ? '试听中…' : '试听' }}
            </button>
          </div>

          <div v-if="voices.length" class="voice-list">
            <div v-for="(voice, index) in voices" :key="voice.id" class="voice-item">
              <input v-model="voice.name" class="settings-input voice-name" placeholder="名称" />
              <input v-model="voice.id" class="settings-input voice-id" placeholder="voiceId" />
              <button class="panel-toggle" type="button" @click="removeVoice(index)">删除</button>
            </div>
          </div>

          <div class="voice-item voice-add">
            <input v-model="newVoiceName" class="settings-input voice-name" placeholder="新音色名称" />
            <input v-model="newVoiceId" class="settings-input voice-id" placeholder="新 voiceId" />
            <button
              class="icon-text-button"
              type="button"
              :disabled="!newVoiceName.trim() || !newVoiceId.trim()"
              @click="addVoice"
            >
              添加
            </button>
          </div>
        </section>

        <section class="settings-section">
          <label class="settings-label">服务配置与状态</label>
          <p class="settings-hint">填写你自己的火山引擎配置。密钥保存在这台 Mac 的加密存储中；这里不回显已保存的值。留空表示不修改。</p>
          <div v-for="field in credentialFields" :key="field.key" class="voice-item">
            <label class="settings-hint" :for="field.key">{{ field.label }}</label>
            <input :id="field.key" v-model="credentialInputs[field.key]" class="settings-input"
              :type="field.secret ? 'password' : 'text'" autocomplete="off"
              :placeholder="credentialStatus?.[field.key] ? '已配置；填写新值可替换' : '尚未配置'" />
            <button v-if="credentialStatus?.[field.key]" class="panel-toggle" type="button"
              :disabled="credentialsBusy" @click="clearCredential(field.key)">移除</button>
          </div>
          <p v-if="credentialMessage" class="settings-hint" role="status">{{ credentialMessage }}</p>
          <button class="icon-text-button" type="button" :disabled="credentialsBusy" @click="saveCredentials">保存服务配置</button>
        </section>

        <section class="settings-section">
          <label class="settings-label">高级人格设置</label>
          <p class="settings-hint">当前仍使用旧版提示词配置。正式的助手名、称呼与风格正在接入；请勿把这里当作 R1 人格设置已验收。</p>
          <textarea
            v-model="systemPrompt"
            class="settings-textarea"
            spellcheck="false"
          />
        </section>
      </div>

      <footer class="settings-footer">
        <button class="exit-button" type="button" @click="close">取消</button>
        <button class="primary-play-button" type="button" @click="save">保存</button>
      </footer>
    </div>
  </div>
</template>
