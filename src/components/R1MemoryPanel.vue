<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Pencil, Plus, Search, Trash2, X } from 'lucide-vue-next'
import type { R1Memory, R1MemorySource } from '../../electron/main/r1/memory'

const props = defineProps<{ temporary: boolean; revision?: number }>()
const emit = defineEmits<{ close: [] }>()
const records = ref<R1Memory[]>([])
const sources = ref<Record<string, R1MemorySource[]>>({})
const tab = ref<'about' | 'topics'>('about')
const query = ref('')
const page = ref(0)
const hasMore = ref(false)
const draft = ref('')
const category = ref<'profile' | 'preference'>('preference')
const editingId = ref<string | null>(null)
const editorOpen = ref(false)
const confirmingId = ref<string | null>(null)
const busy = ref(false)
const message = ref('')
const loading = ref(false)
watch(() => props.revision, () => { void load() })
let loadRevision = 0

const visible = computed(() => records.value.filter((record) =>
  ['profile', 'preference'].includes(record.category)))

function label(categoryValue: R1Memory['category']): string {
  return categoryValue === 'profile' ? '近况' : categoryValue === 'preference' ? '偏好' : '共同结论'
}

async function load(): Promise<void> {
  const revision = ++loadRevision
  records.value = []
  if (props.temporary) return
  loading.value = true
  try {
    const result = await window.seamoR1.memory.list({ query: query.value, page: page.value,
      scope: 'about' })
    if (revision !== loadRevision) return
    if (result.ok) {
      records.value = result.data.entries
      hasMore.value = result.data.hasMore
    } else message.value = '记忆暂时无法读取，请稍后重试。'
  } catch {
    if (revision === loadRevision) message.value = '记忆暂时无法读取，请稍后重试。'
  } finally {
    if (revision === loadRevision) loading.value = false
  }
}

onMounted(load)
watch(query, () => { page.value = 0; void load() })
watch(() => props.temporary, () => {
  editorOpen.value = false
  confirmingId.value = null
  void load()
})

async function save(): Promise<void> {
  if (props.temporary || busy.value || !draft.value.trim()) return
  busy.value = true
  message.value = ''
  try {
    const result = editingId.value
      ? await window.seamoR1.memory.update({ memoryId: editingId.value,
          expectedVersion: records.value.find((record) => record.memoryId === editingId.value)?.version ?? 0,
          content: draft.value, category: category.value })
      : await window.seamoR1.memory.addManual({ content: draft.value, category: category.value })
    if (!result.ok) {
      message.value = result.error.code === 'VERSION_CONFLICT'
        ? '这条记忆已有新版本，请重新打开后再更正。'
        : '保存失败，请检查内容后重试。'
      return
    }
    void load()
    draft.value = ''
    editingId.value = null
    editorOpen.value = false
    message.value = '记忆已保存；可查看来源、继续更正或忘记。'
  } catch {
    message.value = '保存失败，请稍后重试。'
  } finally {
    busy.value = false
  }
}

function edit(record: R1Memory): void {
  message.value = ''
  editingId.value = record.memoryId
  draft.value = record.content
  category.value = record.category === 'profile' ? 'profile' : 'preference'
  confirmingId.value = null
  editorOpen.value = true
}

function newMemory(): void {
  message.value = ''
  editingId.value = null
  draft.value = ''
  category.value = 'preference'
  confirmingId.value = null
  editorOpen.value = true
}

async function showSources(memoryId: string): Promise<void> {
  if (props.temporary || sources.value[memoryId]) return
  try {
    const result = await window.seamoR1.memory.sources(memoryId)
    if (result.ok) sources.value = { ...sources.value, [memoryId]: result.data }
    else message.value = '来源暂时无法读取。'
  } catch {
    message.value = '来源暂时无法读取。'
  }
}

async function forget(record: R1Memory): Promise<void> {
  if (props.temporary || busy.value) return
  if (confirmingId.value !== record.memoryId) return
  busy.value = true
  try {
    const result = await window.seamoR1.memory.forget(record.memoryId, record.version)
    if (!result.ok) {
      message.value = result.error.code === 'VERSION_CONFLICT'
        ? '这条记忆已有新版本，请重新打开后再操作。' : '忘记失败，请重试。'
      return
    }
    void load()
    confirmingId.value = null
    if (editingId.value === record.memoryId) { editingId.value = null; draft.value = ''; editorOpen.value = false }
    message.value = '这条记忆已忘记；不会再用于后续回答。'
  } catch {
    message.value = '忘记失败，请重试。'
  } finally {
    busy.value = false
  }
}

function confirmForget(): void {
  const record = records.value.find((item) => item.memoryId === confirmingId.value)
  if (record) void forget(record)
}
</script>

<template>
  <aside class="r1-basic-side r1-memory-panel" aria-label="关于你的记忆">
    <header><div><small>SEAMO / PERSONAL SPACE</small><h2>关于你的记忆</h2></div>
      <button type="button" aria-label="关闭侧栏" @click="emit('close')"><X :size="19" /></button></header>
    <div class="r1-basic-content">
      <div class="r1-memory-summary"><span>你确认过的背景与持续关注的事</span>
        <button v-if="!temporary && tab === 'about'" type="button" @click="newMemory"><Plus :size="14" />添加</button></div>
      <p v-if="temporary" role="status">当前为临时对话，不读取或保存长期记忆。关闭临时对话后可管理记忆。</p>
      <template v-else>
        <label class="r1-memory-search"><Search :size="15" />
          <input v-model="query" placeholder="查找记忆或话题" aria-label="搜索记忆或话题" /></label>
        <div class="r1-memory-tabs" role="tablist" aria-label="记忆视图">
          <button type="button" role="tab" :aria-selected="tab === 'about'" @click="tab = 'about'">关于我</button>
          <button type="button" role="tab" :aria-selected="tab === 'topics'" @click="tab = 'topics'">持续话题</button>
        </div>
        <template v-if="tab === 'about'">
          <p v-if="loading">正在读取记忆…</p>
          <div v-else-if="!visible.length" class="r1-memory-empty"><p>{{ query ? '没有找到这段记忆' : '这里还没有你保存的记忆' }}</p>
            <button v-if="!query" type="button" @click="newMemory"><Plus :size="14" />添加一段</button></div>
          <article v-for="record in visible" :key="record.memoryId" class="r1-memory-row">
            <small>{{ label(record.category) }} · v{{ record.version }}</small><p>{{ record.content }}</p>
            <details @toggle="showSources(record.memoryId)"><summary>这段记忆从哪里来</summary>
              <p v-for="source in sources[record.memoryId] ?? []" :key="source.messageId">
                {{ source.body }}<small>{{ new Date(source.createdAt).toLocaleString('zh-CN') }}</small></p>
            </details>
            <div class="r1-memory-actions"><button type="button" @click="edit(record)"><Pencil :size="13" />更正</button>
              <button type="button" @click="confirmingId = record.memoryId"><Trash2 :size="13" />忘记</button></div>
          </article>
          <div v-if="page > 0 || hasMore" class="r1-memory-pages">
            <button type="button" :disabled="page === 0 || loading" @click="page -= 1; load()">上一页</button>
            <span>第 {{ page + 1 }} 页</span>
            <button type="button" :disabled="!hasMore || loading" @click="page += 1; load()">下一页</button>
          </div>
        </template>
        <p v-else>持续话题及共同结论的版本接续仍在接入；这里不会把普通记忆伪装成话题。</p>
        <p v-if="message" role="status" class="r1-settings-message">{{ message }}</p>
      </template>
    </div>
  </aside>
  <div v-if="editorOpen" class="r1-memory-modal-backdrop" role="presentation" @click.self="editorOpen = false">
    <form class="r1-memory-modal" role="dialog" aria-modal="true" aria-label="保存记忆" @submit.prevent="save">
      <h3>{{ editingId ? '更正这段记忆' : '添加一段记忆' }}</h3>
      <p>这段内容会作为你确认的长期记忆保存，并保留原始来源。</p>
      <label for="r1-memory-content">内容</label>
      <textarea id="r1-memory-content" v-model="draft" maxlength="1000" rows="4" required />
      <label for="r1-memory-category">归类</label>
      <select id="r1-memory-category" v-model="category"><option value="preference">偏好</option>
        <option value="profile">近况</option></select>
      <div class="r1-memory-dialog-actions"><button type="button" @click="editorOpen = false">取消</button>
        <button type="submit" :disabled="busy || !draft.trim()">{{ editingId ? '保存更正' : '保存记忆' }}</button></div>
      <p v-if="message" role="status">{{ message }}</p>
    </form>
  </div>
  <div v-if="confirmingId" class="r1-memory-modal-backdrop" role="presentation" @click.self="confirmingId = null">
    <div class="r1-memory-modal" role="alertdialog" aria-modal="true" aria-label="确认忘记记忆">
      <h3>忘记这段记忆？</h3>
      <p>{{ records.find((record) => record.memoryId === confirmingId)?.content }}</p>
      <p>这会移除长期记忆；独立保存的事项和提醒不会随之删除。</p>
      <div class="r1-memory-dialog-actions"><button type="button" @click="confirmingId = null">保留</button>
        <button type="button" :disabled="busy" @click="confirmForget">确认忘记</button></div>
      <p v-if="message" role="status">{{ message }}</p>
    </div>
  </div>
</template>
