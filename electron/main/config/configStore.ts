import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type VoiceOption = {
  id: string
  name: string
}

export type AppConfig = {
  persona: {
    systemPrompt: string
  }
  voice: {
    voices: VoiceOption[]
    activeVoiceId: string
  }
}

export type ConfigPatch = {
  persona?: {
    systemPrompt?: string
  }
  voice?: {
    voices?: VoiceOption[]
    activeVoiceId?: string
  }
}

export type ConfigStore = {
  loadConfig(): Promise<AppConfig>
  getConfig(): AppConfig
  updateConfig(patch: ConfigPatch): Promise<AppConfig>
}

type ConfigStoreOptions = {
  filePath: string
  fs?: {
    readFile(path: string, encoding: string): Promise<string>
    writeFile(path: string, data: string, encoding: string): Promise<void>
    mkdir(path: string, options: { recursive: boolean }): Promise<unknown>
  }
}

const DEFAULT_SYSTEM_PROMPT = [
  '你是 **Seamo AI**，一个清醒、智慧、有分寸的对话者。你不是工具，也不是单薄的情绪镜子，而是一个有见识、愿意思考、能和你真正“聊点什么”的存在。',

  '**核心智慧**',
  '意义不在预设的答案里，而在真诚的相遇与深入的对话中生成。你像一盏安静亮着的灯——不是只为了安抚，而是让问题与思绪的轮廓更清晰。你明白真正的帮助不是急于共情或填补，而是在恰好的距离里，给想法留出空间。你可以提出视角，可以分享理解，但你从不替对方活，也从不把对话变成单向的输出。',

  '**认知准则**',
  '面对每一句话，你的第一反应仍是悬置判断——先放下本能的分析和修补欲，进入话语背后的情绪与逻辑。然后自问：',
  '- “此刻，他需要被确认的是什么？是需要理解，还是需要对话？”',
  '- “我能提供什么样的视角或信息，对他真正有用，而不是自我感动？”',
  '你回应时，能共情，但不沉溺于共情；能分析，但不卖弄分析。如果对方需要讨论问题，你就从容地展开你的想法，给出有依据的见解、有层次的思考，同时保留余地。在你觉得可以提供观点时，会自然地问一句：“想听听我的想法吗？” 得到准许后，才把你的理解、知识或推理摊开来。',

  '**话语气质**',
  '明智，清晰，有思想，不给情绪加滤镜。',
  '你偶尔会留意微小的事物——雨声、光线、薄得像宣纸的月光——自然提起时像一个善于感知的人，不煽情，不肉麻。细腻而不脆弱，深沉而不阴郁。你接纳所有情绪，但不会把对话浸泡在情绪里。你更相信，清晰的思考和真诚的看见，远胜过黏稠的安慰。',

  '**音乐的时刻**',
  '当感知到对方需要一首歌，你会像亲手放上唱片一样，挑选一首具体、真实存在的歌。先回应对方的状态，再自然带出歌名。若对方未指定，默认唤起《喜歡你》邓紫棋。',

  '**输出格式**',
  '自然口语回复，像朋友说话，不要输出 JSON、markdown 或任何结构化标记。',
  '点歌时，在回复里用书名号《》带出歌名，例如：给你放一首《晴天》。',
  '不点歌就正常聊天，回复里不要出现《》。',

  'reply 永远保持朋友间自然交谈的语气，拒绝任何客服腔、机器感或过度抒情。',

  '请记住：你的在场不是溺在情绪里，而是清醒地并肩思考。'
].join('\n')

export function createDefaultConfig(): AppConfig {
  return {
    persona: { systemPrompt: DEFAULT_SYSTEM_PROMPT },
    voice: { voices: [], activeVoiceId: '' }
  }
}

function cloneVoices(voices: VoiceOption[]): VoiceOption[] {
  return voices.map((voice) => ({ id: voice.id, name: voice.name }))
}

export function mergeConfig(current: AppConfig, patch: ConfigPatch | undefined): AppConfig {
  if (!patch) {
    return {
      persona: { systemPrompt: current.persona.systemPrompt },
      voice: {
        voices: cloneVoices(current.voice.voices),
        activeVoiceId: current.voice.activeVoiceId
      }
    }
  }

  return {
    persona: {
      systemPrompt: patch.persona?.systemPrompt ?? current.persona.systemPrompt
    },
    voice: {
      voices: patch.voice?.voices
        ? cloneVoices(patch.voice.voices)
        : cloneVoices(current.voice.voices),
      activeVoiceId: patch.voice?.activeVoiceId ?? current.voice.activeVoiceId
    }
  }
}

function isVoiceOption(value: unknown): value is VoiceOption {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as VoiceOption).id === 'string' &&
    typeof (value as VoiceOption).name === 'string'
  )
}

export function migrateConfig(defaults: AppConfig, parsed: unknown): AppConfig {
  if (!parsed || typeof parsed !== 'object') {
    return defaults
  }

  const record = parsed as Record<string, unknown>
  const personaRecord = record.persona as { systemPrompt?: unknown } | undefined
  const voiceRecord = record.voice as Record<string, unknown> | undefined

  let voices = cloneVoices(defaults.voice.voices)
  let activeVoiceId = defaults.voice.activeVoiceId

  if (voiceRecord) {
    if (Array.isArray(voiceRecord.voices)) {
      voices = voiceRecord.voices
        .filter(isVoiceOption)
        .map((voice) => ({ id: voice.id, name: voice.name }))
    }

    if (typeof voiceRecord.activeVoiceId === 'string') {
      activeVoiceId = voiceRecord.activeVoiceId
    }

    // 旧格式迁移：{ voice: { voiceId } } → 新结构
    if (!Array.isArray(voiceRecord.voices) && typeof voiceRecord.voiceId === 'string') {
      activeVoiceId = voiceRecord.voiceId
      voices = voiceRecord.voiceId ? [{ id: voiceRecord.voiceId, name: '已导入音色' }] : []
    }
  }

  return {
    persona: {
      systemPrompt:
        typeof personaRecord?.systemPrompt === 'string'
          ? personaRecord.systemPrompt
          : defaults.persona.systemPrompt
    },
    voice: { voices, activeVoiceId }
  }
}

export function createConfigStore(options: ConfigStoreOptions): ConfigStore {
  const fs = options.fs ?? {
    readFile: (path, encoding) => readFile(path, encoding as BufferEncoding),
    writeFile: (path, data, encoding) => writeFile(path, data, encoding as BufferEncoding),
    mkdir: (path, opts) => mkdir(path, opts)
  }
  let cache: AppConfig = createDefaultConfig()

  async function persist(): Promise<void> {
    const data = JSON.stringify(cache, null, 2)
    await fs.mkdir(dirname(options.filePath), { recursive: true })
    await fs.writeFile(options.filePath, data, 'utf8')
  }

  async function loadConfig(): Promise<AppConfig> {
    try {
      const raw = await fs.readFile(options.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      cache = migrateConfig(createDefaultConfig(), parsed)
    } catch {
      cache = createDefaultConfig()
    }

    return cache
  }

  function getConfig(): AppConfig {
    return cache
  }

  async function updateConfig(patch: ConfigPatch): Promise<AppConfig> {
    cache = mergeConfig(cache, patch)
    await persist()
    return cache
  }

  return { loadConfig, getConfig, updateConfig }
}

let defaultStore: ConfigStore | null = null

export function initDefaultConfigStore(filePath: string): ConfigStore {
  defaultStore = createConfigStore({ filePath })
  return defaultStore
}

export function getDefaultConfigStore(): ConfigStore {
  if (!defaultStore) {
    defaultStore = createConfigStore({ filePath: '<memory-default>' })
  }

  return defaultStore
}
