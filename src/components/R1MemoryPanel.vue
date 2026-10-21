<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronUp, MessageCircle, ArrowRight, Pencil, Plus, Search, Trash2, X } from 'lucide-vue-next'
import type { R1Topic } from '../../electron/main/r1/topics'
import type { R1Api } from '../../electron/shared/r1Api'
import type { R1Memory, R1MemorySource } from '../../electron/main/r1/memory'
import { vModalFocus } from '@/utils/modalFocus'
import { relativeDateTime, relativeDay } from '@/utils/dateLabels'

const props = defineProps<{ temporary: boolean; revision?: number; interactionBusy?: boolean }>()
const emit = defineEmits<{ close: []; continueTopic: [topic: R1Topic]; settings: [] }>()
const topics = ref<R1Topic[]>([])
const expandedTopic = ref<string | null>(null)
type TopicDetails = Extract<Awaited<ReturnType<R1Api['topics']['details']>>, { ok: true }>['data']
const topicDetails = ref<Record<string, TopicDetails>>({})
const topicEditing = ref<R1Topic | null>(null)
const topicConfirming = ref<R1Topic | null>(null)
const topicDialog = ref<HTMLElement | null>(null)
let dialogPreviousFocus: HTMLElement | null = null
watch(() => Boolean(topicEditing.value || topicConfirming.value), async visible => {
  if (visible) {
    dialogPreviousFocus = document.activeElement as HTMLElement | null
    await nextTick()
    const first = topicDialog.value?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled)')
    const focusTarget = first ?? topicDialog.value
    focusTarget?.focus()
  } else {
    if (dialogPreviousFocus?.isConnected) dialogPreviousFocus.focus()
    else document.querySelector<HTMLElement>('.r1-memory-panel [role="tab"][aria-selected="true"]')?.focus()
    dialogPreviousFocus = null
  }
})
function trapTopicFocus(event: KeyboardEvent): void {
  const controls = [...topicDialog.value?.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)') ?? []]
  const first = controls[0], last = controls.at(-1)
  if (!first || !last) { event.preventDefault(); topicDialog.value?.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === topicDialog.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === topicDialog.value)) { event.preventDefault(); first.focus() }
}
const topicTitle = ref(''), topicSummary = ref(''), topicUnresolved = ref(''), topicStatus = ref<'active' | 'resolved'>('active')
const autoMemory = ref(false)
const preparing = ref('idle')
let stopPolicy: (() => void) | null = null
onMounted(() => {
  stopPolicy = window.seamoR1.memory.onPolicyChanged(value => { autoMemory.value = value.enabled })
  void window.seamoR1.memory.policy().then(result => { if (result.ok) autoMemory.value = result.data.enabled }).catch(() => {})
})
onBeforeUnmount(() => { stopPolicy?.(); loadRevision++ })
const records = ref<R1Memory[]>([])
const sources = ref<Record<string, R1MemorySource[]>>({})
const tab = ref<'about' | 'topics'>('about')
const query = ref('')
const page = ref(0)
const hasMore = ref(false)
const draft = ref('')
const category = ref<R1Memory['category']>('preference')
const editingId = ref<string | null>(null)
const editingVersion = ref(0)
const editingContent = ref('')
const editingCategory = ref<R1Memory['category']>('preference')
const confirmingRecord = ref<R1Memory | null>(null)
const editorOpen = ref(false)
const confirmingId = ref<string | null>(null)
const busy = ref(false)
const message = ref('')
const loading = ref(false)
watch(() => props.revision, () => { void load() })
let loadRevision = 0

const visible = computed(() => records.value)

function label(categoryValue: R1Memory['category']): string {
  return categoryValue === 'profile' ? '关于我' : categoryValue === 'preference' ? '偏好' : categoryValue === 'ongoing' ? '近况' : '共同结论'
}

async function load(): Promise<void> {
  const revision = ++loadRevision
  records.value = []; topics.value = []; topicDetails.value = {}; sources.value = {}
  if (props.temporary) { loading.value = false; return }
  loading.value = true
  try {
    if (tab.value === 'topics') {
      const result = await window.seamoR1.topics.list({ query: query.value, page: page.value })
      if (revision !== loadRevision) return
      if (result.ok) {
        topics.value = result.data.entries; hasMore.value = result.data.hasMore; preparing.value = result.data.preparation.state
        if (expandedTopic.value && topics.value.some(topic => topic.topicId === expandedTopic.value)) {
          const details = await window.seamoR1.topics.details(expandedTopic.value)
          if (revision !== loadRevision) return
          if (details.ok) topicDetails.value = { [details.data.topic.topicId]: details.data }
        }
      }
      else message.value = '话题暂时无法读取，请稍后重试。'
      return
    }
    const result = await window.seamoR1.memory.list({ query: query.value, page: page.value,
      scope: 'all' })
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
watch(tab, () => { page.value = 0; expandedTopic.value = null; editorOpen.value = false; confirmingId.value = null; topicEditing.value = null; topicConfirming.value = null; message.value = ''; void load() })
watch(query, () => { page.value = 0; void load() })
watch(() => props.temporary, () => {
  editorOpen.value = false; topicEditing.value = null; topicConfirming.value = null
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
          expectedVersion: editingVersion.value,
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
  editingVersion.value = record.version
  editingContent.value = record.content; editingCategory.value = record.category
  draft.value = record.content
  category.value = record.category
  confirmingId.value = null
  editorOpen.value = true
}

function newMemory(): void {
  message.value = ''
  editingId.value = null
  draft.value = ''; editingContent.value = ''; editingCategory.value = 'preference'
  category.value = 'preference'
  confirmingId.value = null
  editorOpen.value = true
}

async function showSources(memoryId: string): Promise<void> {
  if (props.temporary || sources.value[memoryId]) return
  try {
    const revision = loadRevision
    const result = await window.seamoR1.memory.sources(memoryId)
    if (revision !== loadRevision || props.temporary) return
    if (result.ok) sources.value = { ...sources.value, [memoryId]: result.data }
    else message.value = result.error.code === 'MEMORY_SOURCE_UNAVAILABLE'
      ? '原始来源已不可查看；独立记忆仍保留，清理历史不会自动忘记记忆。' : '来源暂时无法读取。'
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

async function expandTopic(topic: R1Topic): Promise<void> {
  expandedTopic.value = expandedTopic.value === topic.topicId ? null : topic.topicId
  if (!expandedTopic.value) return
  const revision = loadRevision
  try {
    const result = await window.seamoR1.topics.details(topic.topicId)
    if (revision !== loadRevision || props.temporary) return
    if (result.ok) topicDetails.value = { ...topicDetails.value, [topic.topicId]: result.data }
    else message.value = '话题来源暂时无法读取，请刷新后重试。'
  } catch { message.value = '话题来源暂时无法读取。' }
}
function editTopic(topic: R1Topic): void {
  topicEditing.value = topic; topicTitle.value = topic.title; topicSummary.value = topic.summary
  topicUnresolved.value = topic.unresolved.join('\n'); topicStatus.value = topic.status; message.value = ''
}
async function saveTopic(): Promise<void> {
  const topic = topicEditing.value
  if (!topic || busy.value || props.temporary) return
  busy.value = true; message.value = ''
  try {
    const result = await window.seamoR1.topics.update({ topicId: topic.topicId, expectedVersion: topic.version,
      title: topicTitle.value, summary: topicSummary.value, unresolved: topicUnresolved.value.split('\n').map(value => value.trim()).filter(Boolean), status: topicStatus.value })
    if (result.ok) { topicEditing.value = null; message.value = '话题结论已更正；后续交流会使用新版本。'; await load() }
    else message.value = result.error.code === 'VERSION_CONFLICT' ? '话题已有新版本，请取消后重新打开更正。' : '保存失败，请检查内容；仍有未解问题时应保持进行中。'
  } catch { message.value = '保存失败，请重试。' } finally { busy.value = false }
}
async function forgetTopic(): Promise<void> {
  const topic = topicConfirming.value
  if (!topic || busy.value || props.temporary) return
  busy.value = true; message.value = ''
  try {
    const result = await window.seamoR1.topics.forget({ topicId: topic.topicId, expectedVersion: topic.version })
    if (result.ok) { topicConfirming.value = null; message.value = '这个话题已忘记；历史聊天和独立事项仍保留。'; await load() }
    else message.value = result.error.code === 'VERSION_CONFLICT' ? '话题已有新版本，请取消后重新操作。' : '忘记失败，请重试。'
  } catch { message.value = '忘记失败，请重试。' } finally { busy.value = false }
}
async function continueTopic(topic: R1Topic): Promise<void> {
  if (busy.value || props.temporary || props.interactionBusy) return
  busy.value = true; message.value = ''
  try {
    const result = await window.seamoR1.topics.select({ topicId: topic.topicId, expectedVersion: topic.version })
    if (result.ok) emit('continueTopic', result.data)
    else { message.value = '话题已有变化，请刷新后再继续。'; await load() }
  } catch { message.value = '话题暂时无法接续，请重试。' } finally { busy.value = false }
}
function escapeEditor(): void {
  if (busy.value) return
  if (draft.value !== editingContent.value || category.value !== editingCategory.value) {
    message.value = '修改尚未保存，请保存，或点击取消放弃本次修改。'; return
  }
  editorOpen.value = false
}
function confirmForget(): void {
  const record = confirmingRecord.value
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
            <small>{{ label(record.category) }} · {{ relativeDay(record.createdAt) }}{{ record.authorization === 'automatic' ? ' · 自动记住' : '' }}</small><p>{{ record.content }}</p>
            <details @toggle="showSources(record.memoryId)"><summary>这段记忆从哪里来</summary>
              <p v-for="source in sources[record.memoryId] ?? []" :key="source.messageId">
                {{ source.body }}<small>{{ relativeDateTime(source.createdAt) }}</small></p>
            </details>
            <div class="r1-memory-actions"><button type="button" @click="edit(record)"><Pencil :size="13" />更正</button>
              <button type="button" @click="message = ''; confirmingRecord = { ...record }; confirmingId = record.memoryId"><Trash2 :size="13" />忘记</button></div>
          </article>
          <div v-if="page > 0 || hasMore" class="r1-memory-pages">
            <button type="button" :disabled="page === 0 || loading" @click="page -= 1; load()">上一页</button>
            <span>第 {{ page + 1 }} 页</span>
            <button type="button" :disabled="!hasMore || loading" @click="page += 1; load()">下一页</button>
          </div>
        </template>
        <template v-else>
          <p v-if="loading">正在读取话题…</p>
          <p v-if="preparing === 'processing'" role="status">正在整理这段交流的阶段结论…</p>
          <p v-else-if="preparing === 'failed'" role="status">本次整理未完成，已保存的话题仍保留。</p>
          <div v-if="!loading && !topics.length" class="r1-memory-empty"><p>{{ query ? '没有找到这个话题' : '还没有持续关注的话题' }}</p></div>
          <article v-for="topic in topics" :key="topic.topicId" class="topic-row" :class="{ selected: expandedTopic === topic.topicId }">
            <button class="topic-title" type="button" :aria-expanded="expandedTopic === topic.topicId" @click="expandTopic(topic)"><span><strong>{{ topic.title }}</strong><small>{{ relativeDateTime(topic.updatedAt) }}</small></span><ChevronUp v-if="expandedTopic === topic.topicId" :size="16" /><ChevronDown v-else :size="16" /></button>
            <p>{{ topic.summary }}</p>
            <div v-if="expandedTopic === topic.topicId" class="topic-detail">
              <small>{{ topic.status === 'active' ? '进行中' : '已形成结论' }}</small>
              <ul v-if="topic.unresolved.length" aria-label="未解问题"><li v-for="question in topic.unresolved" :key="question">{{ question }}</li></ul>
              <ol aria-label="结论版本"><li v-for="version in topicDetails[topic.topicId]?.versions ?? []" :key="version.version"><time>v{{ version.version }}<br />{{ new Date(version.updatedAt).toLocaleDateString('zh-CN') }}</time><span>{{ version.summary }}</span></li></ol>
              <details><summary>这个话题从哪里来</summary><p v-for="source in topicDetails[topic.topicId]?.sources ?? []" :key="source.messageId">{{ source.role === 'user' ? '你' : '助手' }}：{{ source.body }}<small>{{ relativeDateTime(source.createdAt) }}</small></p></details>
              <p v-if="topicDetails[topic.topicId]?.related.artifacts.length">关联工作稿：{{ topicDetails[topic.topicId].related.artifacts.map(artifact => `${artifact.title} · v${artifact.version}`).join('、') }}</p>
              <div class="r1-memory-actions"><button type="button" :disabled="busy || interactionBusy" @click="continueTopic(topic)"><MessageCircle :size="14" />继续聊这件事</button><button type="button" @click="editTopic(topic)"><Pencil :size="13" />改结论</button><button type="button" @click="topicConfirming = topic"><Trash2 :size="13" />忘记</button></div>
            </div>
          </article>
          <div v-if="page > 0 || hasMore" class="r1-memory-pages"><button type="button" :disabled="!page || loading" @click="page--; load()">上一页</button><span>第 {{ page + 1 }} 页</span><button type="button" :disabled="!hasMore || loading" @click="page++; load()">下一页</button></div>
        </template>
        <button class="memory-setting-link" type="button" @click="emit('settings')"><span>记住重要的事 · {{ autoMemory ? '已开启' : '未开启' }}</span><ArrowRight :size="14" /></button>
        <p v-if="message" role="status" class="r1-settings-message">{{ message }}</p>
      </template>
    </div>
  </aside>
  <div v-if="topicEditing" class="r1-memory-modal-backdrop" role="presentation">
    <form ref="topicDialog" class="r1-memory-modal" role="dialog" aria-modal="true" aria-label="更正话题结论" tabindex="-1" @keydown.tab="trapTopicFocus" @keydown.esc.stop.prevent="!busy && (topicEditing = null)" @submit.prevent="saveTopic">
      <h3>更正这件事的结论</h3><label for="topic-title">话题</label><input id="topic-title" :disabled="busy" v-model="topicTitle" maxlength="80" required />
      <label for="topic-summary">最近结论</label><textarea id="topic-summary" :disabled="busy" v-model="topicSummary" maxlength="1600" rows="4" required />
      <label for="topic-unresolved">未解问题（每行一项）</label><textarea id="topic-unresolved" :disabled="busy" v-model="topicUnresolved" rows="3" />
      <label for="topic-status">状态</label><select id="topic-status" :disabled="busy" v-model="topicStatus"><option value="active">进行中</option><option value="resolved">已形成结论</option></select>
      <p>保留来源与结论版本；保存后旧对话上下文会刷新。</p><div class="r1-memory-dialog-actions"><button type="button" :disabled="busy" @click="topicEditing = null">取消</button><button type="submit" :disabled="busy">保存结论</button></div><p v-if="message" role="alert">{{ message }}</p>
    </form>
  </div>
  <div v-if="topicConfirming" class="r1-memory-modal-backdrop" role="presentation">
    <section ref="topicDialog" class="r1-memory-modal" role="alertdialog" aria-modal="true" aria-label="确认忘记话题" tabindex="-1" @keydown.tab="trapTopicFocus" @keydown.esc.stop.prevent="!busy && (topicConfirming = null)"><h3>忘记这个话题？</h3><p>{{ topicConfirming.title }}</p><p>这个话题及其结论不再用于后续回答。原始聊天、独立事项和提醒保留。</p><div class="r1-memory-dialog-actions"><button type="button" :disabled="busy" @click="topicConfirming = null">保留</button><button type="button" :disabled="busy" @click="forgetTopic">确认忘记</button></div><p v-if="message" role="alert">{{ message }}</p></section>
  </div>
  <div v-if="editorOpen" class="r1-memory-modal-backdrop" role="presentation">
    <form v-modal-focus class="r1-memory-modal" role="dialog" aria-modal="true" aria-label="保存记忆" @keydown.esc.prevent="escapeEditor" @submit.prevent="save">
      <h3>{{ editingId ? '更正这段记忆' : '添加一段记忆' }}</h3>
      <p>这段内容会作为你确认的长期记忆保存，并保留原始来源。</p>
      <label for="r1-memory-content">内容</label>
      <textarea id="r1-memory-content" :disabled="busy" v-model="draft" maxlength="1000" rows="4" required />
      <label for="r1-memory-category">归类</label>
      <select id="r1-memory-category" :disabled="busy" v-model="category"><option value="preference">偏好</option>
        <option value="profile">关于我</option><option value="ongoing">近况</option><option value="conclusion">共同结论</option></select>
      <div class="r1-memory-dialog-actions"><button type="button" :disabled="busy" @click="editorOpen = false">取消</button>
        <button type="submit" :disabled="busy || !draft.trim()">{{ editingId ? '保存更正' : '保存记忆' }}</button></div>
      <p v-if="message" role="status">{{ message }}</p>
    </form>
  </div>
  <div v-if="confirmingId" class="r1-memory-modal-backdrop" role="presentation">
    <div v-modal-focus class="r1-memory-modal" role="alertdialog" @keydown.esc.prevent="!busy && (confirmingId = null)" aria-modal="true" aria-label="确认忘记记忆">
      <h3>忘记这段记忆？</h3>
      <p>{{ confirmingRecord?.content }}</p>
      <p>这会移除长期记忆；独立保存的事项和提醒不会随之删除。</p>
      <div class="r1-memory-dialog-actions"><button type="button" :disabled="busy" @click="confirmingId = null">保留</button>
        <button type="button" :disabled="busy" @click="confirmForget">确认忘记</button></div>
      <p v-if="message" role="status">{{ message }}</p>
    </div>
  </div>
</template>

<style scoped>
.topic-row, .history-group { padding: 18px 0; border-bottom: 1px solid var(--r1-line); }
.topic-title { background: none; border: 0; padding: 0; font: inherit; cursor: pointer; width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px; text-align: left; color: #d8ded0; }
.topic-title strong { display: block; font-size: 14px; font-weight: 500; line-height: 1.6; }
.topic-title small { display: block; color: #85958a; font-size: 10px; margin-top: 4px; }
.topic-row > p { color: #abb9ac; font-size: 12px; line-height: 1.8; margin-top: 13px; }
.topic-detail { margin-top: 15px; padding-top: 9px; border-top: 1px solid var(--r1-line); }
.topic-detail details p { white-space: pre-wrap; overflow-wrap: anywhere; }
.topic-detail ol { list-style: none; margin: 0 0 14px; padding: 0; }
.topic-detail ol li { display: grid; grid-template-columns: 82px 1fr; gap: 10px; font-size: 11px; line-height: 1.8; padding: 9px 0; color: #abb9ac; }
.topic-detail ul { padding-left: 18px; margin: 10px 0; }
.topic-detail ul li { font-size: 11px; line-height: 1.8; padding: 3px 0; color: #abb9ac; }
.topic-detail time { color: #6f8a79; }
.memory-setting-link { background: none; border: 0; font: inherit; cursor: pointer; display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 20px 0; color: #95b6a5; font-size: 11px; }
.r1-memory-modal input { width: 100%; padding: 8px; background: #18201e; border: 1px solid var(--r1-line); color: var(--r1-text); border-radius: 5px; }
</style>
