<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronUp, History, Search, X } from 'lucide-vue-next'
import type { HistorySession, SessionMessage } from '../../electron/main/r1/conversations'

const props = defineProps<{ temporary: boolean; assistantName: string }>()
const emit = defineEmits<{ close: [] }>()
const sessions = ref<HistorySession[]>([])
const query = ref('')
const page = ref(0)
const hasMore = ref(false)
const loading = ref(false)
const selectedId = ref<string | null>(null)
const messages = ref<SessionMessage[]>([])
const messagesLoading = ref(false)
const error = ref('')
let listRevision = 0
let messageRevision = 0

function dateLabel(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
async function load(): Promise<void> {
  const revision = ++listRevision
  ++messageRevision
  sessions.value = []
  selectedId.value = null
  messages.value = []
  hasMore.value = false
  loading.value = false
  messagesLoading.value = false
  error.value = ''
  if (props.temporary) return
  loading.value = true
  try {
    const result = await window.seamoR1.history.list({ query: query.value, page: page.value })
    if (revision !== listRevision || props.temporary) return
    if (!result.ok) throw new Error(result.error.code)
    sessions.value = result.data.sessions
    hasMore.value = result.data.hasMore
  } catch {
    if (revision === listRevision) error.value = '历史暂时无法读取，请稍后重试。'
  } finally { if (revision === listRevision) loading.value = false }
}
async function selectSession(sessionId: string): Promise<void> {
  const revision = ++messageRevision
  messages.value = []
  error.value = ''
  if (selectedId.value === sessionId) {
    selectedId.value = null
    messagesLoading.value = false
    return
  }
  if (props.temporary) return
  selectedId.value = sessionId
  messagesLoading.value = true
  try {
    const result = await window.seamoR1.history.messages(sessionId)
    if (revision !== messageRevision || props.temporary) return
    if (!result.ok) throw new Error(result.error.code)
    messages.value = result.data
  } catch {
    if (revision === messageRevision) error.value = '这段对话暂时无法打开，请重试。'
  } finally { if (revision === messageRevision) messagesLoading.value = false }
}
onMounted(load)
watch(query, () => { page.value = 0; void load() })
watch(() => props.temporary, () => { page.value = 0; void load() })
</script>

<template>
  <aside class="r1-basic-side r1-history-panel" aria-label="历史对话">
    <header><div><small>SEAMO / OUR CONVERSATIONS</small><h2>聊过的话</h2></div>
      <button type="button" aria-label="关闭侧栏" @click="emit('close')"><X :size="19" /></button></header>
    <div class="r1-basic-content">
      <p v-if="temporary" role="status">当前为临时对话，不读取普通对话历史。关闭临时对话后可查看。</p>
      <template v-else>
        <div class="r1-history-summary"><span>保存在这台设备上的普通对话</span></div>
        <label class="r1-history-search"><Search :size="15" /><input v-model="query"
          placeholder="找一句话或一个话题" aria-label="搜索历史对话" /></label>
        <p v-if="loading" role="status">正在读取历史…</p>
        <p v-if="error" role="alert" class="r1-history-error">{{ error }} <button type="button" @click="load">重试</button></p>
        <div v-if="!loading && !error && !sessions.length" class="r1-history-empty"><History :size="27" />
          <p>{{ query ? '没有找到这段对话' : '从今天的一句话开始' }}</p></div>
        <section v-for="session in sessions" :key="session.sessionId" class="r1-history-session">
          <button type="button" class="r1-history-title" :aria-expanded="selectedId === session.sessionId"
            @click="selectSession(session.sessionId)"><span><strong>{{ session.title }}</strong>
              <small>{{ dateLabel(session.lastMessageAt) }} · {{ session.messageCount }} 条消息</small></span>
            <ChevronUp v-if="selectedId === session.sessionId" :size="16" /><ChevronDown v-else :size="16" /></button>
          <template v-if="selectedId === session.sessionId">
            <p v-if="messagesLoading" role="status">正在打开对话…</p>
            <article v-for="message in messages" :key="message.messageId" class="r1-history-message" :class="message.role">
              <div><small>{{ message.role === 'user' ? '你' : message.role === 'assistant' ? assistantName : '系统' }}</small>
                <time>{{ dateLabel(message.createdAt) }}</time></div><p>{{ message.body }}</p>
            </article>
          </template>
        </section>
        <div v-if="page > 0 || hasMore" class="r1-memory-pages"><button type="button" :disabled="page === 0 || loading" @click="page -= 1; load()">上一页</button>
          <span>第 {{ page + 1 }} 页</span><button type="button" :disabled="!hasMore || loading" @click="page += 1; load()">下一页</button></div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.r1-history-summary{margin-bottom:18px;color:#89978f;font-size:11px}
.r1-history-search{display:flex;align-items:center;gap:9px;height:43px;margin-bottom:19px;padding:0 12px;border:1px solid var(--r1-line);border-radius:6px;background:#ffffff06;color:#788a83}
.r1-history-search input{flex:1;min-width:0;height:100%;border:0;outline:0;background:none;color:var(--r1-text);font-size:12px}
.r1-history-empty{display:flex;flex-direction:column;align-items:center;gap:16px;padding:60px 8px;color:#75877d;text-align:center;font-size:12px}
.r1-history-session{padding:19px 0;border-bottom:1px solid var(--r1-line)}
.r1-history-title{display:flex;align-items:center;justify-content:space-between;gap:13px;width:100%;padding:0;border:0;background:none;text-align:left;color:#a6b9ab}
.r1-history-title span{min-width:0}.r1-history-title strong{display:block;color:#d8dccf;font-size:13px;font-weight:400;line-height:1.7;overflow-wrap:anywhere}.r1-history-title small{display:block;margin-top:7px;color:#71867a;font-size:10px}.r1-history-title svg{flex:none}
.r1-history-message{padding:15px 0!important}.r1-history-message div{display:flex;align-items:center;justify-content:space-between;gap:10px}.r1-history-message small,.r1-history-message time{color:#778e80!important;font-size:10px}.r1-history-message p{margin:9px 0 0;color:#bacbbd;font-size:12px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}.r1-history-message.user p{color:#e0e5d9}
.r1-history-error{font-size:12px;line-height:1.7;color:#d9a596}.r1-history-error button{border:0;background:none;color:var(--r1-aqua);font-size:11px}
</style>
