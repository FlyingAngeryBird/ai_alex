<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import type { AppConfig, ConfigPatch, VoiceOption } from '@/types/app'

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
          <p class="settings-hint">火山引擎 voiceId，可配置多个便于快速切换。当前音色留空则使用 .env 默认值。</p>

          <div class="voice-row">
            <select v-model="activeVoiceId" class="settings-input">
              <option value="">（默认 / .env）</option>
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
          <label class="settings-label">角色提示词</label>
          <p class="settings-hint">定义 lingmo 的性格、语气与输出格式。保存后立即生效。</p>
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
