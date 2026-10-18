<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ArrowRight, FileText, Globe, History, MessageCircle } from 'lucide-vue-next'
import type { ParticleState, UiMessage } from '@/types/app'
import type { RealtimeSearchState } from '../../electron/main/r1/realtimeSearch'

const props = defineProps<{
  assistantName: string
  messages: UiMessage[]
  partialText: string
  state: ParticleState
  temporaryMode: boolean
  searchState?: RealtimeSearchState | null
  lastTopic?: string | null
}>()
const emit = defineEmits<{ openHistory: []; openSearch: []; startChat: []; sendPrompt: [text: string]; resumeTopic: [title: string] }>()
const expanded = ref(false)
const searchLabel = computed(() => {
  const s = props.searchState
  if (!s) return ''
  if (s.phase === 'timeout') return s.sources.length ? '检索已结束，正在整理已获得的信息。' : '本次检索已超时，暂未获得可靠结果。'
  if (s.phase === 'failed') return '本次检索未完成。'
  if (s.phase === 'ready' || s.phase === 'cancelled') return ''
  if (s.elapsedMs >= 5000) return s.phase === 'reading' ? '正在核对来源…' : s.phase === 'waiting' ? '正在整理检索结果…' : '检索较慢，正在等待结果…'
  return s.phase === 'reading' ? '正在读取相关来源…' : s.phase === 'waiting' ? '正在整理检索结果…' : s.hint ? '我正在查询，请稍等…' : '正在检索相关信息…'
})
const replyExpanded = ref(false)
const dialogue = computed(() => props.messages.filter((message) => message.role !== 'system'))
const latestUser = computed(() => [...props.messages].reverse().find((message) => message.role === 'user'))
const latestResponse = computed(() => [...props.messages].reverse().find((message) => message.role === 'assistant'))
const latestError = computed(() => props.messages.at(-1)?.role === 'system'
  ? props.messages.at(-1) : null)
const replyIsLong = computed(() => {
  const text = latestResponse.value?.text ?? ''
  return [...text].length > 67 || text.includes('\n')
})
const recentMessages = computed(() => dialogue.value.slice(-6))
const statusLabel: Record<ParticleState, string> = {
  idle: '在这里', listening: '正在听', thinking: '正在想', speaking: '正在说',
  playing: '音乐陪伴', error: '需要检查'
}
// Keep the wait state honest: a model turn can take tens of seconds, so show elapsed time.
const thinkingStartedAt = ref<number | null>(null)
const tick = ref(Date.now())
let ticker: number | null = null
watch(() => props.state, value => {
  if (value === 'thinking') {
    thinkingStartedAt.value ??= Date.now(); tick.value = Date.now()
    if (ticker === null) ticker = window.setInterval(() => { tick.value = Date.now() }, 1000)
  } else {
    thinkingStartedAt.value = null
    if (ticker !== null) { window.clearInterval(ticker); ticker = null }
  }
}, { immediate: true })
const presenceLabel = computed(() => {
  const base = props.temporaryMode ? '临时对话' : statusLabel[props.state]
  if (props.state !== 'thinking' || thinkingStartedAt.value === null) return base
  return `${base} · ${Math.max(1, Math.floor((tick.value - thinkingStartedAt.value) / 1000))}s`
})
onBeforeUnmount(() => { if (ticker !== null) window.clearInterval(ticker) })
</script>

<template>
  <section class="r1-conversation" :data-expanded="replyExpanded || expanded" aria-label="当前对话">
    <div class="r1-conversation-copy" aria-live="polite">
      <span class="r1-presence"><i :data-state="state" />{{ presenceLabel }}<b>/</b>{{ assistantName }}</span>
      <button v-if="recentMessages.length > 2" class="r1-recent-toggle" type="button"
        :aria-expanded="expanded" @click="expanded = !expanded">
        <History :size="13" />{{ expanded ? '收起最近对话' : '查看最近对话' }}
      </button>
      <div v-if="expanded" class="r1-recent-dialogue">
        <p v-for="message in recentMessages" :key="message.id">
          <small>{{ message.role === 'user' ? '你' : assistantName }}</small>{{ message.text }}
        </p>
        <button type="button" @click="emit('openHistory')">查看全部对话 <ArrowRight :size="13" /></button>
      </div>
      <p v-if="partialText" class="r1-user-line">{{ partialText }}</p>
      <p v-else-if="latestUser" class="r1-user-line">{{ latestUser.text }}</p>
      <p v-if="searchLabel" class="r1-search-status" role="status" :data-active="['searching', 'reading', 'waiting'].includes(searchState!.phase)"><span aria-hidden="true" />{{ searchLabel }}</p>
      <h1 class="r1-current-reply" :class="{ pending: state === 'thinking', long: replyIsLong, expanded: replyExpanded }">
        {{ latestResponse?.text || (state === 'listening' ? '嗯，你说。' : '我在。今天想从哪件事聊起？') }}
      </h1>
      <button v-if="replyIsLong" class="r1-expand-reply" type="button" :aria-expanded="replyExpanded"
        @click="replyExpanded = !replyExpanded">{{ replyExpanded ? '收起全文' : '展开全文' }}</button>
      <p v-if="latestError" class="r1-inline-error" role="status">{{ latestError.text }}</p>
      <details v-if="searchState?.sources.length && searchState.phase !== 'cancelled'" class="r1-search-evidence">
        <summary>查看检索来源 · 查询 {{ searchState.searches }} 次 / 读页 {{ searchState.pages }} 次</summary>
        <article v-for="source in searchState.sources" :key="String(source.sourceRef)">
          <strong>{{ source.title }}</strong><p>{{ source.url }}</p>
          <small>查询/访问：{{ source.accessedAt }} · 页面日期：{{ source.publishedAt || '未知' }} · {{ source.readStatus === 'not_read' ? '仅搜索摘要' : source.readStatus === 'partial' ? '部分正文' : '已读取正文' }}</small>
        </article>
      </details>
    </div>
    <button v-if="!latestUser && !temporaryMode && lastTopic" class="r1-last-topic" type="button"
      @click="emit('resumeTopic', lastTopic)"><History :size="14" /><span>上次聊到：{{ lastTopic }}</span><ArrowRight :size="14" /></button>
    <div v-if="!latestUser && !temporaryMode" class="r1-starters">
      <button type="button" @click="emit('sendPrompt', '今天有点累，陪我聊会儿。')"><MessageCircle :size="15" />聊聊今天</button>
      <button type="button" @click="emit('sendPrompt', '帮我查查周末安静的去处')"><Globe :size="15" />找个周末去处</button>
      <button type="button" @click="emit('sendPrompt', '帮我整理一下产品方案的思路')"><FileText :size="15" />理理思路</button>
    </div>
  </section>
</template>

<style scoped>
.r1-last-topic { display: inline-flex; align-items: center; gap: 8px; margin: 10px auto 0; border: 0; background: none; color: var(--r1-muted, #9da8a5); font-size: 12px; cursor: pointer; }
.r1-last-topic:hover { color: var(--r1-accent, #9ed8ce); }
.r1-last-topic:focus-visible { outline: 2px solid var(--r1-accent, #9ed8ce); outline-offset: 3px; border-radius: 3px; }
.r1-search-status { display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--r1-accent, #9ed8ce); font-size: 13px; margin: 10px 0; }
.r1-search-status span { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
.r1-search-status[data-active="true"] span { animation: search-breathe 1.5s ease-in-out infinite; }
.r1-search-evidence { margin: 12px auto 0; max-width: 640px; max-height: 180px; overflow-y: auto; text-align: left; color: var(--r1-muted, #9da8a5); font-size: 12px; }
.r1-search-evidence summary { cursor: pointer; text-align: center; }
.r1-search-evidence article { padding: 10px 0; border-bottom: 1px solid rgba(158, 216, 206, .12); }
.r1-search-evidence p { overflow-wrap: anywhere; margin: 4px 0; }
@keyframes search-breathe { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .r1-search-status span { animation: none !important; } }
:global(.r1-reduce-motion) .r1-search-status span { animation: none !important; }
</style>
