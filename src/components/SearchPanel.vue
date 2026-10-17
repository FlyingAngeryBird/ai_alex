<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Item } from '../../electron/shared/r1Api'
import type { SearchCandidate, SearchResult } from '../../electron/main/providers/searchProvider'

const emit = defineEmits<{ close: [] }>()
const props = defineProps<{ temporaryMode: boolean }>()
const query = ref('')
const result = ref<SearchResult | null>(null)
const busy = ref(false)
const error = ref('')
const selected = ref<SearchCandidate | null>(null)
const draftKind = ref<'note' | 'todo'>('note')
const draftTitle = ref('')
const draftBody = ref('')
const savedItem = ref<Item | null>(null)
const saveActionId = ref('')
const reminderActionId = ref('')
const reminderAt = ref('')
const reminderSaved = ref(false)
const persistAcknowledged = ref(false)
let requestVersion = 0

watch([draftKind, draftTitle, draftBody], () => {
  if (!savedItem.value) saveActionId.value = ''
})
watch(reminderAt, () => {
  if (!reminderSaved.value) reminderActionId.value = ''
})

async function search(): Promise<void> {
  const text = query.value.trim()
  if (!text || busy.value) return
  const version = ++requestVersion
  busy.value = true
  error.value = ''
  try {
    const response = await window.seamoR1.search.web(text)
    if (version !== requestVersion) return
    if (!response.ok) {
      error.value = response.error.message
      return
    }
    result.value = response.data
    selected.value = null
    savedItem.value = null
  } catch {
    if (version === requestVersion) error.value = '查询失败，请稍后重试。'
  } finally {
    if (version === requestVersion) busy.value = false
  }
}

async function open(candidateId: string): Promise<void> {
  const response = await window.seamoR1.search.open(candidateId)
  if (!response.ok) error.value = response.error.message
}

function select(candidate: SearchCandidate): void {
  selected.value = candidate
  draftKind.value = 'note'
  draftTitle.value = candidate.title.slice(0, 80)
  draftBody.value = `${candidate.snippet ? `${candidate.snippet}\n\n` : ''}来源：${candidate.url}\n查询时间：${candidate.queriedAtUtc}\n说明：仅搜索摘要，正文未核实。`
  savedItem.value = null
  reminderAt.value = ''
  reminderSaved.value = false
  saveActionId.value = ''
  reminderActionId.value = ''
  error.value = ''
}

async function saveSelected(): Promise<void> {
  if (!selected.value || savedItem.value || busy.value) return
  if (props.temporaryMode && !persistAcknowledged.value) {
    error.value = '请先确认：保存的事项与提醒会在退出临时对话后继续保留。'
    return
  }
  if (!draftTitle.value.trim() || !draftBody.value.trim()) {
    error.value = '请填写标题和内容。'
    return
  }
  busy.value = true
  error.value = ''
  if (!saveActionId.value) saveActionId.value = crypto.randomUUID()
  try {
    const response = await window.seamoR1.items.create({ actionId: saveActionId.value,
      kind: draftKind.value, title: draftTitle.value, body: draftBody.value })
    if (!response.ok) throw new Error(response.error.message)
    savedItem.value = response.data.item
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败，请重试。'
  } finally { busy.value = false }
}

async function createReminder(): Promise<void> {
  if (!savedItem.value || !reminderAt.value || reminderSaved.value || busy.value) return
  const due = new Date(reminderAt.value)
  if (!Number.isFinite(due.getTime()) || due.getTime() <= Date.now()) {
    error.value = '请选择未来的提醒时间。'
    return
  }
  busy.value = true
  error.value = ''
  if (!reminderActionId.value) reminderActionId.value = crypto.randomUUID()
  try {
    const response = await window.seamoR1.reminders.create({ actionId: reminderActionId.value,
      itemId: savedItem.value.itemId,
      linkPurpose: savedItem.value.kind === 'todo' ? 'todo_due' : 'other',
      body: `查看：${savedItem.value.title}`, dueAtUtc: due.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, kind: 'standard' })
    if (!response.ok) throw new Error(response.error.message)
    reminderSaved.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '提醒未保存，事项仍保留。'
  } finally { busy.value = false }
}

function close(): void {
  requestVersion += 1
  emit('close')
}

function searchedAt(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
</script>

<template>
  <div class="search-overlay" @keydown.stop @keyup.stop>
    <section class="search-panel" aria-label="联网查询">
      <header class="search-header">
        <div><p class="search-eyebrow">Seamo AI · 联网查询</p><h2>查找公开来源</h2>
          <p>这里显示搜索摘要。打开来源后请自行核对正文、日期和现时状态。</p></div>
        <button type="button" class="search-secondary" @click="close">关闭</button>
      </header>
      <form class="search-form" @submit.prevent="search">
        <label for="web-query">查询内容</label>
        <div><input id="web-query" v-model="query" maxlength="100" placeholder="例如：上海本周末展览（最多100字）" />
          <button type="submit" :disabled="busy || !query.trim()">{{ busy ? '查询中…' : '查询' }}</button></div>
      </form>
      <p v-if="error" role="alert" class="search-error">{{ error }}</p>
      <div v-if="result" class="search-results">
        <p class="search-meta">“{{ result.query }}” · 查询于 {{ searchedAt(result.queriedAtUtc) }} · 仅搜索摘要</p>
        <p v-if="!result.candidates.length" class="search-empty">没有取得可用的公开网页候选。可以换一个查询词。</p>
        <ol v-else>
          <li v-for="candidate in result.candidates" :key="candidate.candidateId">
            <h3>{{ candidate.title }}</h3>
            <small>{{ candidate.url }}</small>
            <p v-if="candidate.snippet">{{ candidate.snippet }}</p>
            <div class="search-result-footer"><span>页面日期：{{ candidate.pageDate ? searchedAt(candidate.pageDate) : '未知' }} · 正文未读取</span>
              <div><button type="button" @click="open(candidate.candidateId)">打开来源</button>
                <button type="button" @click="select(candidate)">选中并记录</button></div></div>
          </li>
        </ol>
      </div>
      <p v-else-if="!busy" class="search-empty">输入问题后再查询。尚未配置密钥时会明确提示。</p>
      <section v-if="selected" class="search-save" aria-label="记录选中的来源">
        <h3>记录选中的来源</h3>
        <p>这份草稿来自搜索摘要，你可以修改内容；保存后会得到真实事项。</p>
        <label v-if="temporaryMode"><input v-model="persistAcknowledged" type="checkbox" />我确认：事项和提醒会独立保存，退出临时对话后仍保留。</label>
        <div class="search-save-kind"><label><input v-model="draftKind" type="radio" value="note" :disabled="!!savedItem" />便签</label>
          <label><input v-model="draftKind" type="radio" value="todo" :disabled="!!savedItem" />待办</label></div>
        <label>标题<input v-model="draftTitle" maxlength="80" :disabled="!!savedItem" /></label>
        <label>内容<textarea v-model="draftBody" maxlength="8000" rows="4" :disabled="!!savedItem" /></label>
        <button v-if="!savedItem" type="button" :disabled="busy" @click="saveSelected">保存事项</button>
        <p v-else class="search-saved">事项已保存 · {{ savedItem.itemId }}</p>
        <div v-if="savedItem && !reminderSaved" class="search-reminder">
          <label>提醒时间<input v-model="reminderAt" type="datetime-local" /></label>
          <button type="button" :disabled="busy || !reminderAt" @click="createReminder">为这条事项设提醒</button>
        </div>
        <p v-if="reminderSaved" class="search-saved">关联提醒已保存。</p>
      </section>
    </section>
  </div>
</template>

<style scoped>
.search-overlay{position:absolute;inset:0;z-index:70;display:grid;place-items:center;background:rgba(2,7,12,.72);backdrop-filter:blur(14px)}
.search-panel{display:flex;flex-direction:column;width:min(760px,calc(100vw - 64px));max-height:calc(100vh - 72px);padding:28px;border:1px solid rgba(127,207,205,.35);border-radius:22px;background:#112029;box-shadow:0 26px 80px #0009;color:#f5f2e9}
.search-header{display:flex;justify-content:space-between;gap:20px;align-items:start}.search-header h2{margin:4px 0 8px;font-size:25px}.search-header p{margin:0;color:#b7c9ca;font-size:13px;line-height:1.6}
.search-eyebrow{letter-spacing:.18em;text-transform:uppercase;font-size:10px!important;color:#85dbce!important}.search-secondary{border:1px solid #769293;border-radius:9px;background:transparent;padding:8px 12px;cursor:pointer}
.search-form{margin-top:24px}.search-form label{display:block;margin-bottom:8px;font-size:12px;color:#c9d8d7}.search-form div{display:flex;gap:10px}.search-form input{flex:1;min-width:0;padding:12px 13px;border:1px solid #537374;border-radius:10px;background:#09151b;color:#fff;font:inherit}.search-form button,.search-result-footer button{border:0;border-radius:9px;background:#8bdacc;color:#0b2428;padding:10px 16px;font-weight:700;cursor:pointer}.search-form button:disabled{opacity:.5;cursor:default}
.search-error{color:#ffae9d;font-size:13px}.search-results{overflow:auto;margin-top:18px}.search-meta,.search-empty{color:#afc1c2;font-size:12px}.search-results ol{padding:0;list-style:none}.search-results li{padding:15px 0;border-top:1px solid #355157}.search-results h3{margin:0 0 6px;font-size:16px}.search-results small{display:block;overflow-wrap:anywhere;color:#84c5ba}.search-results li p{color:#d5dfdb;font-size:13px;line-height:1.55}.search-result-footer{display:flex;justify-content:space-between;align-items:center;gap:12px;color:#a9bcbd;font-size:11px}
.search-result-footer>div{display:flex;gap:8px}.search-save{overflow:auto;flex-shrink:0;max-height:38vh;border-top:1px solid #537374;padding-top:16px}.search-save h3{margin:0 0 5px}.search-save p{font-size:12px;color:#b9cbcb}.search-save>label{display:block;margin:10px 0;font-size:12px}.search-save>label>input:not([type=checkbox]),.search-save textarea,.search-reminder input{display:block;width:100%;margin-top:5px;padding:9px;border:1px solid #537374;border-radius:8px;background:#09151b;color:white;font:inherit}.search-save-kind{display:flex;gap:14px;margin:10px 0;font-size:12px}.search-save>button,.search-reminder button{border:0;border-radius:8px;background:#8bdacc;color:#0b2428;padding:9px 12px;font-weight:700;cursor:pointer}.search-reminder{display:flex;gap:12px;align-items:end;margin-top:12px}.search-reminder label{flex:1;font-size:12px}.search-saved{color:#9ce2ce!important}
</style>
