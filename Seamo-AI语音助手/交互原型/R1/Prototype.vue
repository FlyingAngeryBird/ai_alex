<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import ParticleSphere from '@/components/ParticleSphere.vue'
import Icon from './Icon.vue'
import { usePrototype } from './usePrototype'
import { displayDate, formatTime, tracks } from './fixtures'

const {
  data, view, panel, input, reply, lastUser, phase, temporary, result, toast, modal, voiceDraft,
  voiceOpen, voiceIssue, memoryFilter, memoryTopicId, memoryQuery, filteredTopics,
  itemFilter, itemQuery, groupedItems, historyTopicId, historyGroups, activeTopicId, undoItem,
  job, searchQuery, nextSearchFails, selectedCandidateId, searchOptions,
  musicTab, musicQuery, musicSource, musicSearched, trackId, musicStarted, playing, position, queue,
  focus, editor, settings, bands, audioLevel, seen, currentTrack, particleState, statusLabel,
  filteredMemories, filteredItems, foundTracks, lyricIndex, outstandingCount,
  notify, openPanel, interrupt, respond, continueTopic, saveCandidate, search, controlJob,
  playTrack, toggleMusic, skip, favorite, moveQueue, openItem, openReminder, saveReminder, saveItem, confirmItemSave, toggleItem, restoreItem,
  completeItem, deleteItem, confirmDelete, editMemory, saveMemory, toggleTemporary,
  startFocus, generateWork, undoWork, saveWork, copyWork, exportWork, saveSettings, startVoice, cancelVoice,
  closeModal, sendVoice, send, continueRemember, confirmRemember, confirmCandidateSave, previewDue, previewPartial, reset
} = usePrototype()

const composer = ref(null)
const dialog = ref(null)
const selectedSource = ref(null)
const conversationExpanded = ref(false)
const replyExpanded = ref(false)
const searchEditing = ref(false)
const compareOpen = ref(false)
const workInputOpen = ref(false)
const musicFeedbackOpen = ref(false)
const previewingVoice = ref(false)
const currentDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
const panelNames = { memory: '关于你的记忆', items: '手边的事', history: '聊过的话', settings: '偏好设置', search: '一起看看', work: '一起理一理', music: '音乐', review: '原型评审' }
const resultItem = computed(() => result.value?.id ? data.items.find(item => item.id === result.value.id) : null)
const resultMemory = computed(() => result.value?.id ? data.memories.find(memory => memory.id === result.value.id) : null)
const memoryContext = computed(() => temporary.value ? '' : data.memories.find(memory => memory.category === '共同结论' && memory.enabled)?.text)
const recentMessages = computed(() => temporary.value ? [] : data.history.slice(-6))
const replyIsLong = computed(() => reply.value.length > 67 || reply.value.includes('\n'))
const resultVisible = computed(() => result.value && result.value.type !== 'memory' && !(result.value.type === panel.value || result.value.type === 'item' && panel.value === 'items'))
const selectedCandidate = computed(() => searchOptions.value.find(candidate => candidate.id === selectedCandidateId.value))
const jobLabels = { running: '正在查找', paused: '已暂停', cancelled: '已取消', error: '查询未完成', done: '有两个选择' }
const jobLabel = computed(() => job.value?.status === 'done' && job.value?.workflow
  ? job.value.workflow.itemId ? '委托已完成' : job.value.workflow.selectedId ? '等你定个时间' : '等你选一个'
  : jobLabels[job.value?.status])
const resultIcon = computed(() => ({ search: 'Globe', memory: 'Brain', item: 'NotebookPen', work: 'FileText', due: 'Bell', temporaryMemory: 'ShieldCheck' })[result.value?.type])
const resultTitle = computed(() => {
  if (result.value?.type === 'search') return jobLabel.value || '一起看看'
  if (result.value?.type === 'memory') return resultMemory.value ? '这件事，记住了' : '记忆已移除'
  if (result.value?.type === 'item') return resultItem.value?.title || '事项已移除'
  if (result.value?.type === 'work') return editor.title
  if (result.value?.type === 'due') return '约好的时间到了 · 模拟提醒'
  return '回到普通对话，再记住？'
})
const resultDetail = computed(() => {
  if (result.value?.type === 'search') return job.value?.title
  if (result.value?.type === 'memory') return resultMemory.value?.text || '这段内容不再用于后续对话'
  if (result.value?.type === 'work') return editor.saved ? '已保存为记录' : '讨论稿 · 可继续修改'
  if (result.value?.type === 'item') return resultItem.value?.reminder ? `${displayDate(resultItem.value.reminder)} · 模拟提醒` : '已保存到手边的事'
  if (result.value?.type === 'temporaryMemory') return '临时对话中的内容不会自动进入记忆'
  return result.value?.title
})

function showResult() {
  if (result.value?.type === 'search') panel.value = 'search'
  else if (result.value?.type === 'work') panel.value = 'work'
  else if (result.value?.type === 'memory') panel.value = 'memory'
  else if (result.value?.type === 'item' && resultItem.value) openItem(resultItem.value)
  else if (result.value?.type === 'due') { result.value = null; send('接着昨天的产品方案聊') }
  else if (result.value?.type === 'temporaryMemory') continueRemember()
}

function musicLibrary(tab = '发现') {
  musicTab.value = tab
  panel.value = 'music'
}

function newMemory() {
  modal.value = { type: 'memory', draft: { id: '', text: '', category: '偏好', source: '你确认的内容', enabled: true } }
}

function showSource(candidate) {
  selectedSource.value = candidate
  modal.value = { type: 'source' }
}

function saveAndRemind(candidate) {
  const item = saveCandidate(candidate)
  if (!item) { modal.value.withReminder = true; return }
  if (modal.value?.type !== 'item') openItem(item)
}

function selectCandidate(candidate) {
  selectedCandidateId.value = candidate.id
}

function continueHistory(group) {
  if (data.topics.some(topic => topic.id === group.id)) { continueTopic(group.id); return }
  lastUser.value = [...group.messages].reverse().find(message => message.role === 'user')?.text || ''
  reply.value = [...group.messages].reverse().find(message => message.role === 'assistant')?.text || '嗯，我们接着聊。'
  activeTopicId.value = 'other'
  conversationExpanded.value = true
  panel.value = ''
  view.value = 'home'
  notify('已回到这段交流，可以继续说')
}

function playVoicePreview() {
  if (!('speechSynthesis' in window)) { notify('当前浏览器无法试听示意声音'); return }
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(`你好，我是 ${settings.assistantName || 'Seamo AI'}。`)
  utterance.lang = 'zh-CN'
  utterance.rate = settings.voice === '沉稳男声' ? 0.88 : 0.98
  previewingVoice.value = true
  utterance.onend = utterance.onerror = () => { previewingVoice.value = false }
  window.speechSynthesis.speak(utterance)
}

function candidateLabel(candidate) {
  if (job.value?.workflow && !job.value.workflow.itemId) return '选这个，记下并提醒'
  return data.items.some(item => item.sourceId === candidate.id) ? '已记下' : '记下来'
}

function submitMusicSearch() {
  musicSearched.value = true
  musicTab.value = '发现'
  panel.value = 'music'
}

function musicFeedback(action) {
  if (action === 'less') {
    if (!data.lessMusic.includes(trackId.value)) data.lessMusic.push(trackId.value)
  }
  const next = queue.value[queue.value.indexOf(trackId.value) + 1] || queue.value.find(id => id !== trackId.value)
  if (next) playTrack(next)
  else playing.value = false
  notify(action === 'less' ? '已记下偏好，并跳过这首' : '已跳过这首')
  musicFeedbackOpen.value = false
}

function toggleVoice() {
  if (!voiceOpen.value) { startVoice(); return }
  if (voiceDraft.value.trim()) { sendVoice(); return }
  phase.value = 'idle'
  voiceIssue.value = '原型未连接麦克风。输入一句话模拟识别结果。'
}

function lyricStyle(index) {
  const distance = Math.abs(index - lyricIndex.value)
  return { transform: `translateY(${(index - lyricIndex.value) * 66}px)`, opacity: distance > 3 ? 0 : [1, 0.5, 0.25, 0.1][distance] }
}

function runScenario(name) {
  panel.value = ''
  view.value = 'home'
  if (name === 'chat') send('今天有点累，先不想听建议。')
  if (name === 'memory') send('记住我周末喜欢安静的地方，不想赶行程。')
  if (name === 'continue') send('接着昨天的产品方案聊')
  if (name === 'search') send('帮我查查周末安静的去处')
  if (name === 'reminder') send('明晚8点提醒我继续整理产品方案')
  if (name === 'music') send('放点音乐，我们继续聊')
  if (name === 'work') send('帮我整理一下思路：先跑通功能链路，再调整界面。')
  if (name === 'failure') { nextSearchFails.value = true; send('帮我查查周末的展览') }
  if (name === 'due') previewDue()
  if (name === 'partial') previewPartial()
  if (name === 'combined') send('帮我查查周末安静的去处，选好后记下来，明晚8点提醒我')
  if (name === 'voiceDenied') { startVoice(); phase.value = 'idle'; voiceIssue.value = '示例：麦克风权限未开启。可以输入文字继续，或在正式应用中前往系统设置授权。' }
  if (name === 'voiceSilent') { startVoice(); phase.value = 'idle'; voiceIssue.value = '示例：这次没有识别到声音。检查输入设备后重试，或输入文字继续。' }
}

let previousFocus = null
watch(modal, async value => {
  if (value) {
    previousFocus = document.activeElement
    await nextTick()
    const first = dialog.value?.querySelector('input, textarea, select, button:not(.dialog-close)')
    ;(first || dialog.value)?.focus()
  } else {
    await nextTick()
    if (previousFocus?.isConnected) previousFocus.focus()
  }
})

function trapFocus(event) {
  const elements = [...dialog.value.querySelectorAll('button:not([disabled]), input, textarea, select, a[href]')].filter(element => element.offsetParent !== null)
  const first = elements[0], last = elements[elements.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
</script>

<template>
  <div class="seamo-app" :class="{ 'has-panel': panel, 'wide-panel': ['search', 'work'].includes(panel), 'reading-mode': ['search', 'work', 'history', 'items', 'memory'].includes(panel), 'voice-active': voiceOpen, 'reduce-motion': data.reducedMotion }" :data-view="view">
    <header class="app-header">
      <a class="brand" href="#" aria-label="返回 Seamo 陪伴首页" @click.prevent="view = 'home'; panel = ''">
        <Icon name="AudioLines" :size="25" /><span>Seamo <span class="brand-light">AI</span></span>
      </a>
      <span class="header-date">{{ currentDate }}</span>
      <div class="header-right">
        <button v-if="job && panel !== 'search' && (view === 'music' || !resultVisible) && (result?.type === 'search' || !result) && job.status !== 'cancelled'" class="header-task" aria-label="查看查询任务" @click="panel = 'search'"><Icon :name="job.status === 'running' ? 'LoaderCircle' : job.status === 'done' ? 'CircleCheck' : 'Globe'" :size="13" /><span>{{ jobLabel }}</span></button>
        <button class="prototype-badge" @click="openPanel('review')"><span class="tiny-square" />R1 交互原型 <span class="badge-extra">· 模拟数据</span><Icon name="ChevronDown" :size="13" /></button>
        <span class="mic-privacy"><Icon name="MicOff" :size="14" /><span>麦克风未开启</span></span>
      </div>
    </header>

    <nav class="rail" aria-label="主导航">
      <button class="nav-button" :class="{ active: view === 'home' && !panel }" aria-label="陪伴" data-tip="陪伴" @click="view = 'home'; panel = ''"><Icon name="MessageCircle" /><span>陪伴</span></button>
      <button class="nav-button" :class="{ active: view === 'music' && !panel }" aria-label="音乐" data-tip="音乐" @click="view = 'music'; panel = ''"><Icon name="Headphones" /><span>音乐</span></button>
      <span class="nav-divider" />
      <button class="nav-button" :class="{ active: panel === 'memory' }" aria-label="记忆" data-tip="记忆" @click="openPanel('memory')"><Icon name="Brain" /><span>记忆</span></button>
      <button class="nav-button" :class="{ active: panel === 'items' }" aria-label="事项" data-tip="事项" @click="openPanel('items')"><Icon name="NotebookPen" /><span>事项</span><i v-if="outstandingCount" class="nav-dot" /></button>
      <div class="rail-bottom">
        <button class="nav-button" :class="{ active: panel === 'history' }" aria-label="历史对话" data-tip="历史对话" @click="openPanel('history')"><Icon name="History" /></button>
        <button class="nav-button" :class="{ active: panel === 'settings' }" aria-label="设置" data-tip="设置" @click="openPanel('settings')"><Icon name="Settings2" /></button>
      </div>
    </nav>

    <main class="main-space" aria-label="Seamo 陪伴空间">
      <div class="particle-space" :data-mode="view" :class="{ 'particle-muted': data.reducedMotion }">
        <ParticleSphere :state="data.reducedMotion ? 'idle' : particleState" :audio-level="audioLevel" :audio-bands="bands" />
      </div>

      <div v-if="view === 'home'" class="ambient-strip">
        <div v-if="musicStarted" class="mini-player">
          <button class="mini-track" aria-label="展开音乐沉浸页" @click="view = 'music'">
            <span class="artwork mini-art"><Icon name="Headphones" :size="18" /><img :src="currentTrack.art" alt="演示曲目配图" @error="$event.target.style.display = 'none'" /></span>
            <span><strong>{{ currentTrack.title }}</strong><small>{{ playing ? '模拟播放' : '已暂停' }} · {{ currentTrack.artist }}</small></span>
          </button>
          <button class="icon-button" :aria-label="playing ? '暂停音乐' : '继续音乐'" :data-tip="playing ? '暂停' : '继续播放'" @click="toggleMusic"><Icon :name="playing ? 'Pause' : 'Play'" :size="16" /></button>
        </div>
        <div v-if="focus.active" class="focus-chip">
          <Icon name="Timer" :size="16" /><span>{{ formatTime(focus.remaining) }}</span><small>{{ focus.paused ? '已暂停' : '专注中' }}</small>
          <button class="icon-button compact" :aria-label="focus.paused ? '继续专注' : '暂停专注'" @click="focus.paused = !focus.paused"><Icon :name="focus.paused ? 'Play' : 'Pause'" :size="14" /></button>
          <button class="icon-button compact" aria-label="结束专注" data-tip="结束专注" @click="focus.active = false"><Icon name="X" :size="14" /></button>
        </div>
      </div>

      <section v-if="view === 'home'" class="conversation-space" aria-label="当前对话">
        <div class="conversation-copy" aria-live="polite">
          <span class="presence"><span :class="['status-dot', phase]" />{{ temporary ? '临时对话' : statusLabel }}<span class="presence-divider">/</span>{{ data.assistantName }}</span>
          <button v-if="recentMessages.length > 2" class="recent-toggle" :aria-expanded="conversationExpanded" @click="conversationExpanded = !conversationExpanded"><Icon name="History" :size="13" />{{ conversationExpanded ? '收起最近对话' : '查看最近对话' }}</button>
          <div v-if="conversationExpanded && recentMessages.length" class="recent-dialogue"><p v-for="message in recentMessages" :key="message.id" :class="message.role"><small>{{ message.role === 'user' ? '你' : data.assistantName }}</small>{{ message.text }}</p><button @click="openPanel('history')">查看全部对话<Icon name="ArrowRight" :size="13" /></button></div>
          <p v-if="lastUser" class="user-utterance">{{ lastUser }}</p>
          <div class="reply-wrap"><h1 class="assistant-reply" :class="{ 'reply-pending': phase === 'thinking', 'reply-body': replyIsLong, 'reply-clamped': replyIsLong && !replyExpanded }">{{ phase === 'listening' ? '嗯，你说。' : reply }}</h1><button v-if="replyIsLong" class="reply-expand" @click="replyExpanded = !replyExpanded">{{ replyExpanded ? '收起' : '展开全文' }}</button></div>
          <button v-if="result?.type === 'memory' && resultMemory" class="memory-receipt" @click="panel = 'memory'"><Icon name="Brain" :size="13" />查看或更正记忆<Icon name="ArrowRight" :size="13" /></button>
          <button v-if="!seen && memoryContext" class="memory-thread" @click="continueTopic('seamo-plan')"><Icon name="History" :size="14" /><span>上次聊到：{{ memoryContext }}</span><Icon name="ArrowRight" :size="14" /></button>
        </div>

        <article v-if="resultVisible" class="current-result" :class="{ 'result-error': result.type === 'search' && job?.status === 'error' }" aria-label="本次结果">
          <button class="result-open" @click="showResult">
            <span class="result-symbol"><Icon :name="resultIcon" :size="21" /></span>
            <span class="result-copy"><strong>{{ resultTitle }}</strong><small>{{ resultDetail }}</small></span>
            <Icon name="ChevronRight" :size="17" />
          </button>
          <div v-if="result.type === 'search' && job?.status === 'running'" class="result-operations">
            <span class="progress-dots"><i /><i /><i /></span>
            <button class="icon-button compact" aria-label="暂停查询" data-tip="暂停查询" @click="controlJob('pause')"><Icon name="Pause" :size="15" /></button>
            <button class="icon-button compact" aria-label="取消查询" data-tip="取消查询" @click="controlJob('cancel')"><Icon name="X" :size="15" /></button>
          </div>
          <button v-else-if="result.type === 'search' && ['error', 'paused', 'cancelled'].includes(job?.status)" class="icon-button" aria-label="重试或继续查询" data-tip="重试 / 继续" @click="controlJob('resume')"><Icon name="RotateCcw" :size="17" /></button>
          <button v-else class="icon-button compact" aria-label="收起本次结果，不取消任务" data-tip="收起" @click="result = null"><Icon name="X" :size="15" /></button>
        </article>

        <div v-if="!seen" class="conversation-starters">
          <button @click="send('今天有点累，陪我聊会儿。')"><Icon name="MessageCircle" :size="15" />聊聊今天</button>
          <button @click="send('帮我查查周末安静的去处')"><Icon name="Globe" :size="15" />找个周末去处</button>
          <button @click="send('帮我整理一下产品方案的思路')"><Icon name="FileText" :size="15" />理理思路</button>
        </div>
      </section>

      <section v-if="view === 'music'" class="music-scene" aria-label="音乐沉浸页">
        <div class="music-page-top">
          <button class="back-link" @click="view = 'home'"><Icon name="ArrowLeft" :size="17" />返回对话</button>
          <span class="music-mode">{{ musicStarted ? playing ? '模拟播放' : '已暂停' : '音乐陪伴' }}</span>
          <div class="music-page-tools">
            <button class="icon-button" aria-label="搜索音乐" data-tip="搜索音乐" @click="musicLibrary('发现')"><Icon name="Search" /></button>
            <button class="icon-button" aria-label="播放队列" data-tip="播放队列" @click="musicLibrary('队列')"><Icon name="ListMusic" /></button>
          </div>
        </div>

        <div class="lyric-window" aria-label="模拟同步歌词">
          <div v-if="currentTrack.lyrics.length && musicStarted" class="lyric-anchor">
            <p v-for="(line, index) in currentTrack.lyrics" :key="currentTrack.id + index" :style="lyricStyle(index)" :class="{ current: index === lyricIndex }" class="lyric-line">{{ line }}</p>
          </div>
          <div v-else class="lyric-empty"><span>{{ musicStarted ? '纯音乐' : '把时间，留给一首歌。' }}</span><p>{{ currentTrack.note }}</p></div>
        </div>

        <div class="music-player-block">
          <div class="album-and-title">
            <div class="artwork album-art"><Icon name="Headphones" :size="30" /><img :src="currentTrack.art" alt="演示专辑的风景配图" @error="$event.target.style.display = 'none'" /></div>
            <div class="track-copy"><p class="overline">SEAMO SESSIONS · 演示曲目</p><h1>{{ currentTrack.title }}</h1><p class="track-artist">{{ currentTrack.artist }}<span> · {{ currentTrack.album }}</span></p></div>
          </div>
          <div class="progress-and-controls">
            <label class="sr-only" for="music-progress">歌曲进度</label>
            <input id="music-progress" v-model.number="position" class="music-progress" type="range" min="0" :max="currentTrack.duration" step="0.1" :style="{ '--progress': `${position / currentTrack.duration * 100}%` }" />
            <div class="music-times"><span>{{ formatTime(position) }}</span><span>{{ formatTime(currentTrack.duration) }}</span></div>
            <div class="playback-controls">
              <button class="icon-button" aria-label="上一首" data-tip="上一首" @click="skip(-1)"><Icon name="SkipBack" :size="18" /></button>
              <button class="play-button" :aria-label="playing ? '暂停' : '播放'" @click="toggleMusic"><Icon :name="playing ? 'Pause' : 'Play'" :size="23" /></button>
              <button class="icon-button" aria-label="下一首" data-tip="下一首" @click="skip(1)"><Icon name="SkipForward" :size="18" /></button>
              <button class="icon-button favorite-button" :class="{ selected: data.favorites.includes(trackId) }" :aria-label="data.favorites.includes(trackId) ? '取消收藏当前歌曲' : '收藏当前歌曲'" data-tip="收藏" @click="favorite(trackId)"><Icon name="Heart" :size="18" /></button>
              <div class="feedback-control"><button class="icon-button" aria-label="歌曲反馈" data-tip="这首歌" @click="musicFeedbackOpen = !musicFeedbackOpen"><Icon name="Ellipsis" :size="18" /></button><div v-if="musicFeedbackOpen" class="feedback-menu"><button @click="musicFeedback('skip')">这次跳过</button><button @click="musicFeedback('less')">以后少推荐这类</button></div></div>
              <div class="volume-control"><Icon name="Volume2" :size="16" /><input v-model.number="data.volume" aria-label="音乐音量（模拟）" type="range" min="0" max="100" /></div>
            </div>
          </div>
        </div>
      </section>

      <div class="composer-area" :class="{ 'music-composer': view === 'music' }">
        <div v-if="voiceOpen" class="voice-inline" aria-label="模拟语音输入"><div class="voice-inline-head"><span><Icon name="Mic" :size="16" />{{ phase === 'listening' ? '模拟收音中' : '确认识别文字' }}</span><button class="icon-button compact" aria-label="取消本次语音" @click="cancelVoice"><Icon name="X" :size="15" /></button></div><p v-if="voiceIssue" class="voice-issue">{{ voiceIssue }}</p><input v-model="voiceDraft" aria-label="模拟识别文字" placeholder="输入一句话模拟识别结果" @keydown.enter.prevent="sendVoice" /><div class="voice-inline-actions"><button @click="voiceDraft = '今天有点累，先不想听建议。'">倾诉示例</button><button @click="voiceDraft = '放点音乐，我们继续聊'">听歌示例</button><button class="primary-command" @click="sendVoice">发送这句话</button></div></div>
        <form class="composer" @submit.prevent="send()">
          <button class="microphone-button" type="button" :aria-label="voiceOpen ? '结束模拟收音' : '开始模拟语音输入'" :data-tip="voiceOpen ? '结束模拟收音' : '模拟语音输入'" @click="toggleVoice"><Icon :name="voiceOpen && phase === 'listening' ? 'Square' : 'Mic'" :size="20" /></button>
          <input ref="composer" v-model="input" :placeholder="`和 ${data.assistantName} 说点什么…`" aria-label="对话输入" autocomplete="off" :maxlength="2000" @keydown.enter="$event.isComposing && $event.preventDefault()" />
          <button v-if="phase === 'speaking' || phase === 'thinking'" class="icon-button stop-button" type="button" :aria-label="phase === 'speaking' ? '停止朗读' : '停止本次回答'" :data-tip="phase === 'speaking' ? '停止朗读' : '停止回答'" @click="interrupt"><Icon name="Square" :size="15" /></button>
          <button class="send-button" type="submit" aria-label="发送消息" :disabled="!input.trim()"><Icon name="ArrowUp" :size="20" /></button>
        </form>
        <div class="composer-foot"><button class="quiet-button" @click="toggleTemporary"><Icon :name="temporary ? 'ShieldCheck' : 'MessageCircle'" :size="13" />{{ temporary ? '临时对话' : '普通对话' }}<Icon name="ChevronDown" :size="11" /></button><span>{{ playing && phase === 'speaking' ? '音乐随助手回应降低音量 · 原型示意' : phase === 'speaking' ? '脚本回应 · 无语音输出' : '原型演示 · 未连接云端服务' }}</span></div>
      </div>
    </main>

    <aside v-if="panel" class="side-panel" :aria-label="panelNames[panel]">
      <header class="panel-header"><div><p class="overline">{{ panel === 'review' ? 'R1 / PROTOTYPE' : 'SEAMO / PERSONAL SPACE' }}</p><h2>{{ panelNames[panel] }}</h2></div><button class="icon-button" aria-label="关闭侧栏" data-tip="关闭" @click="panel = ''"><Icon name="X" /></button></header>
      <div class="panel-content">

        <template v-if="panel === 'memory'">
          <div class="panel-summary"><span>你确认过的背景与持续关注的事</span><button v-if="memoryFilter === '关于我'" class="text-command" @click="newMemory"><Icon name="Plus" :size="15" />添加</button></div>
          <label class="search-input"><Icon name="Search" :size="17" /><input v-model="memoryQuery" placeholder="查找记忆或话题" aria-label="搜索记忆或话题" /></label>
          <div class="tabs" role="tablist" aria-label="记忆视图"><button v-for="category in ['关于我', '持续话题']" :key="category" role="tab" :aria-selected="memoryFilter === category" @click="memoryFilter = category; memoryTopicId = ''">{{ category }}</button></div>
          <template v-if="memoryFilter === '关于我'">
            <div v-for="memory in filteredMemories" :key="memory.id" class="memory-row"><div class="row-meta"><span>{{ memory.category }}</span><span>{{ memory.updated }}</span></div><p>{{ memory.text }}</p><details class="memory-source"><summary>这段记忆从哪里来</summary><p>{{ memory.source }}</p></details><div class="row-actions"><button class="text-command" @click="editMemory(memory)"><Icon name="Pencil" :size="14" />更正</button><button class="text-command muted" @click="modal = { type: 'forget', id: memory.id, title: memory.text }"><Icon name="Trash2" :size="14" />忘记</button></div></div>
            <div v-if="!filteredMemories.length" class="empty-state"><Icon name="Brain" :size="28" /><p>{{ memoryQuery ? '没有找到这段记忆' : '这里还没有记忆' }}</p><button class="text-command" @click="newMemory"><Icon name="Plus" :size="14" />添加一段</button></div>
          </template>
          <template v-else><article v-for="topic in filteredTopics" :key="topic.id" class="topic-row" :class="{ selected: memoryTopicId === topic.id }"><button class="topic-title" @click="memoryTopicId = memoryTopicId === topic.id ? '' : topic.id"><span><strong>{{ topic.title }}</strong><small>{{ topic.updated }}</small></span><Icon :name="memoryTopicId === topic.id ? 'ChevronUp' : 'ChevronDown'" :size="16" /></button><p>{{ topic.current }}</p><div v-if="memoryTopicId === topic.id" class="topic-detail"><ol><li v-for="event in topic.events" :key="event.id"><time>{{ event.when }}</time><span>{{ event.text }}</span></li></ol><button class="text-command" @click="continueTopic(topic.id)"><Icon name="MessageCircle" :size="14" />继续聊这件事</button></div></article><div v-if="!filteredTopics.length" class="empty-state"><p>还没有持续关注的话题</p></div></template>
          <button class="memory-setting-link" @click="openPanel('settings')"><span>记住重要的事 · {{ data.autoMemory ? '已开启' : '未开启' }}</span><Icon name="ArrowRight" :size="14" /></button>
        </template>

        <template v-if="panel === 'items'">
          <div class="panel-summary"><span>{{ outstandingCount }} 件待办</span><button class="text-command" @click="openItem()"><Icon name="Plus" :size="15" />新建</button></div>
          <label class="search-input"><Icon name="Search" :size="17" /><input v-model="itemQuery" placeholder="找一件事" aria-label="搜索事项" /></label>
          <div class="tabs" role="tablist" aria-label="事项分类"><button v-for="category in ['待办', '记录']" :key="category" role="tab" :aria-selected="itemFilter === category" @click="itemFilter = category">{{ category }}</button></div>
          <details v-for="group in groupedItems" :key="group.title" class="item-group" :open="group.title !== '已完成'"><summary>{{ group.title }} <small v-if="group.title === '已完成'">{{ group.entries.length }}</small></summary><article v-for="item in group.entries" :key="item.id" class="item-row" :class="{ completed: item.done }">
            <button v-if="item.kind === '待办'" class="task-checkbox" role="checkbox" :aria-checked="item.done" :aria-label="`${item.done ? '恢复' : '完成'}${item.title}`" @click="toggleItem(item)"><Icon v-if="item.done" name="Check" :size="14" /></button>
            <span v-else class="note-symbol"><Icon name="FileText" :size="19" /></span>
            <button class="item-content" @click="openItem(item)"><strong>{{ item.title }}</strong><p>{{ item.body }}</p><small v-if="item.reminderPending" class="reminder-pending"><Icon name="BellOff" :size="12" />提醒未完成，记录已保存</small><small v-else-if="item.reminder" class="reminder-time"><Icon name="Bell" :size="12" />{{ displayDate(item.reminder) }}</small><small v-else>{{ item.kind }} · {{ item.created }}</small></button>
            <button class="icon-button compact" :aria-label="`${item.reminderPending ? '重试设置' : '修改'}${item.title}的提醒`" :data-tip="item.reminderPending ? '重试提醒' : '修改提醒'" @click="openReminder(item)"><Icon name="Bell" :size="14" /></button>
            <button class="icon-button compact row-delete" :aria-label="`删除${item.title}`" data-tip="删除" @click="deleteItem(item)"><Icon name="Trash2" :size="14" /></button>
          </article></details>
          <div v-if="!filteredItems.length" class="empty-state"><Icon name="NotebookPen" :size="28" /><p>这里暂时没有事项</p><button class="text-command" @click="openItem()"><Icon name="Plus" :size="14" />记下一件事</button></div>
        </template>

        <template v-if="panel === 'history'">
          <div class="panel-summary"><span>{{ historyGroups.length }} 个话题</span><span>本地原型记录</span></div>
          <div v-if="!data.history.length" class="empty-state"><Icon name="History" :size="28" /><p>从今天的一句话开始</p></div>
          <section v-for="group in historyGroups" :key="group.id" class="history-group"><button class="topic-title" @click="historyTopicId = historyTopicId === group.id ? '' : group.id"><span><strong>{{ group.title }}</strong><small>{{ group.latest }} · {{ group.messages.length }} 条消息</small></span><Icon :name="historyTopicId === group.id ? 'ChevronUp' : 'ChevronDown'" :size="16" /></button><template v-if="historyTopicId === group.id"><article v-for="message in group.messages" :key="message.id" class="history-message" :class="message.role"><div class="row-meta"><span>{{ message.role === 'user' ? '你' : data.assistantName }}</span><time>{{ message.time }}</time></div><p>{{ message.text }}</p></article><button class="text-command history-continue" @click="continueHistory(group)"><Icon name="MessageCircle" :size="14" />继续聊这件事</button></template></section>
        </template>

        <template v-if="panel === 'search'">
          <div v-if="job && !searchEditing" class="search-brief"><div><small>当前条件</small><p>{{ job.query }}</p></div><button class="icon-button" aria-label="修改查询条件" data-tip="修改条件" @click="searchEditing = true"><Icon name="Pencil" :size="16" /></button></div>
          <form v-else class="search-input" @submit.prevent="search(searchQuery); searchEditing = false"><Icon name="Globe" :size="17" /><input v-model="searchQuery" aria-label="查询条件" placeholder="想了解什么？" /><button class="icon-button compact" aria-label="提交查询" type="submit"><Icon name="ArrowUp" :size="17" /></button></form>
          <span class="demo-caption">示例结果 · 未实时联网</span>
          <div v-if="job?.workflow" class="workflow-plan"><span>这次的委托</span><p>找去处 <Icon name="ChevronRight" :size="12" /> 你来选 <Icon name="ChevronRight" :size="12" /> 记下并提醒</p><small>{{ job.workflow.itemId ? '已完成，结果在「手边的事」' : job.workflow.reminder ? `已约定 ${displayDate(job.workflow.reminder)} 提醒；选定后再保存` : '提醒时间待补充，尚未创建提醒' }}</small></div>
          <div v-if="job" class="job-status"><div class="section-title"><Icon :name="job.status === 'error' ? 'RotateCcw' : job.status === 'done' ? 'CheckCheck' : 'Globe'" :size="17" /><h3>{{ jobLabel }}</h3></div><ol v-if="job.status === 'running' || job.status === 'paused'" class="job-steps"><li :class="{ done: job.step >= 0 }">理解你的条件</li><li :class="{ done: job.step >= 1 }">查找并核对来源</li><li :class="{ done: job.step >= 2 }">整理适合的选择</li></ol><div v-if="job.status === 'running'" class="row-actions"><button class="text-command" @click="controlJob('pause')"><Icon name="Pause" :size="14" />暂停</button><button class="text-command muted" @click="controlJob('cancel')"><Icon name="X" :size="14" />取消查询</button></div><div v-if="['error', 'paused', 'cancelled'].includes(job.status)" class="job-recovery"><p>{{ job.status === 'error' ? '示例服务暂时不可用。你的查询条件已保留。' : job.status === 'paused' ? '停在这里。准备好了再继续。' : '这次查询已结束，已保存的记录不受影响。' }}</p><button class="primary-command" @click="controlJob('resume')"><Icon name="RotateCcw" :size="15" />{{ job.status === 'paused' ? '继续查询' : '重新查询' }}</button></div></div>
          <template v-if="job?.status === 'done'">
            <div v-if="searchOptions.length > 1" class="compare-toggle"><span>{{ searchOptions.length }} 个候选</span><button class="text-command" @click="compareOpen = !compareOpen"><Icon name="Columns2" :size="15" />{{ compareOpen ? '返回列表' : '并排比较' }}</button></div>
            <div v-if="compareOpen" class="compare-grid"><article v-for="candidate in searchOptions" :key="candidate.id"><h3>{{ candidate.title }}</h3><small>{{ candidate.meta }}</small><p>{{ candidate.text }}</p><p class="candidate-caveat">{{ candidate.caveat }}</p><button class="primary-command" @click="selectCandidate(candidate); compareOpen = false">选这个</button></article></div>
            <template v-else><article v-for="(candidate, index) in searchOptions" :key="candidate.id" class="candidate-row" :class="{ selected: selectedCandidateId === candidate.id }"><span class="candidate-number">0{{ index + 1 }}</span><div class="candidate-main"><div class="row-meta"><span>{{ candidate.meta }}</span></div><button class="candidate-title" @click="selectCandidate(candidate)">{{ candidate.title }}<Icon v-if="selectedCandidateId === candidate.id" name="Check" :size="16" /></button><p>{{ candidate.text }}</p><p class="candidate-caveat">{{ candidate.caveat }}</p><button class="source-link" @click="showSource(candidate)"><Icon name="Globe" :size="12" />示例来源<Icon name="ChevronRight" :size="12" /></button><div class="row-actions"><button class="text-command" @click="selectCandidate(candidate)"><Icon :name="selectedCandidateId === candidate.id ? 'Check' : 'Circle'" :size="14" />{{ selectedCandidateId === candidate.id ? '已选中' : '选这个' }}</button><template v-if="selectedCandidateId === candidate.id"><button class="text-command" @click="saveCandidate(candidate)"><Icon :name="data.items.some(item => item.sourceId === candidate.id) ? 'Check' : 'Bookmark'" :size="14" />{{ candidateLabel(candidate) }}</button><button v-if="!job.workflow || job.workflow.itemId" class="text-command muted" @click="saveAndRemind(candidate)"><Icon name="Bell" :size="14" />加个提醒</button></template></div></div></article></template>
            <div v-if="!searchOptions.length" class="empty-state"><p>当前候选都已排除。可以修改条件再找。</p><button class="text-command" @click="searchEditing = true">修改条件</button></div>
          </template>
        </template>

        <template v-if="panel === 'work'">
          <template v-if="!editor.generated || workInputOpen"><label class="field-label" for="work-input">原始想法</label><textarea id="work-input" v-model="editor.input" class="text-field work-input" rows="4" placeholder="写下你的想法，或者粘贴一段文字…" /><div class="row-actions"><button class="primary-command" @click="generateWork(); workInputOpen = false"><Icon name="Sparkles" :size="15" />{{ editor.generated ? '重新整理' : '整理一下' }}</button><span class="demo-caption">脚本示例</span></div></template>
          <template v-if="editor.generated"><button v-if="!workInputOpen" class="work-source-toggle" @click="workInputOpen = true"><Icon name="FileText" :size="14" />查看原始想法<Icon name="ChevronDown" :size="14" /></button><div class="editor-heading"><span class="overline">讨论稿</span><span class="editor-state">{{ editor.saved ? '已保存为记录' : '草稿 · 自动保留' }}</span></div><input v-model="editor.title" class="editor-title" aria-label="讨论稿标题" @input="editor.saved = false" /><textarea v-model="editor.body" class="editor-body" aria-label="讨论稿正文" @input="editor.saved = false" /><div class="editor-toolbar"><button class="primary-command" @click="saveWork"><Icon name="Bookmark" :size="15" />保存记录</button><button class="icon-button" aria-label="复制讨论稿" data-tip="复制" @click="copyWork"><Icon name="Copy" :size="17" /></button><button class="icon-button" aria-label="导出讨论稿" data-tip="导出 Markdown" @click="exportWork"><Icon name="Download" :size="17" /></button><button v-if="editor.previousBody" class="text-command" @click="undoWork"><Icon name="Undo2" :size="15" />撤销上次修改</button></div><p class="editor-hint">在对话输入框说“第二段短一些”，只会修改对应段落。</p></template>
        </template>

        <template v-if="panel === 'music'">
          <div class="tabs" role="tablist" aria-label="音乐内容"><button v-for="tab in ['发现', '队列', '收藏']" :key="tab" role="tab" :aria-selected="musicTab === tab" @click="musicTab = tab">{{ tab }}<span v-if="tab === '队列'">{{ queue.length }}</span><span v-if="tab === '收藏'">{{ data.favorites.length }}</span></button></div>
          <template v-if="musicTab === '发现'"><form class="search-input" @submit.prevent="submitMusicSearch"><Icon name="Search" :size="17" /><input v-model="musicQuery" aria-label="搜索歌曲、歌手" placeholder="搜索歌曲、歌手" /><button type="submit" class="icon-button compact" aria-label="搜索演示曲目"><Icon name="ArrowUp" :size="17" /></button></form><label class="source-selector">音源<select v-model="musicSource" aria-label="音源"><option value="all">自动选择</option><option value="netease">网易云</option><option value="kuwo">酷我</option><option value="joox">JOOX</option></select></label></template>
          <div v-if="musicTab !== '发现' || musicSearched" class="music-results">
            <article v-for="track in foundTracks" :key="track.id" class="track-row"><button class="artwork track-art" :aria-label="`播放${track.title}`" @click="playTrack(track.id)"><Icon name="Play" :size="17" /><img :src="track.art" alt="演示配图" @error="$event.target.style.display = 'none'" /></button><div class="track-row-copy"><button @click="playTrack(track.id)">{{ track.title }}<span v-if="musicStarted && track.id === trackId" class="track-playing"><Icon name="AudioLines" :size="13" /></span></button><small>{{ track.artist }} · {{ track.source }}</small></div><div class="track-actions"><button v-if="musicTab === '队列'" class="icon-button compact" :aria-label="`上移${track.title}`" data-tip="上移" @click="moveQueue(track.id, -1)"><Icon name="ArrowUp" :size="14" /></button><button v-else class="icon-button compact" :aria-label="`加入队列${track.title}`" data-tip="加入队列" @click="queue.includes(track.id) ? notify('已经在队列中') : queue.push(track.id)"><Icon name="Plus" :size="15" /></button><button class="icon-button compact favorite-button" :class="{ selected: data.favorites.includes(track.id) }" :aria-label="`${data.favorites.includes(track.id) ? '取消收藏' : '收藏'}${track.title}`" data-tip="收藏" @click="favorite(track.id)"><Icon name="Heart" :size="15" /></button><button v-if="musicTab === '队列' && track.id !== trackId" class="icon-button compact" :aria-label="`从队列移除${track.title}`" data-tip="移除" @click="queue = queue.filter(id => id !== track.id)"><Icon name="X" :size="14" /></button></div></article>
            <div v-if="!foundTracks.length" class="empty-state"><Icon :name="musicTab === '收藏' ? 'Heart' : 'Search'" :size="28" /><p>{{ musicTab === '收藏' ? '还没有收藏的音乐' : '没有匹配的演示曲目' }}</p><button v-if="musicTab === '发现'" class="text-command" @click="musicQuery = ''; musicSource = 'all'">查看全部示例</button></div>
          </div>
          <div v-else class="music-discovery"><div class="discovery-header"><span class="overline">此刻，慢下来</span><Icon name="Headphones" :size="18" /></div><div class="discovery-art artwork"><Icon name="Headphones" :size="32" /><img :src="tracks[1].art" alt="森林配图" @error="$event.target.style.display = 'none'" /></div><h3>给思绪留一点空间</h3><p>轻一点，没有歌词。</p><button class="primary-command" @click="playTrack('forest')"><Icon name="Play" :size="15" />播放演示</button><button class="text-command" @click="musicSearched = true">查看 3 首演示曲目<Icon name="ArrowRight" :size="14" /></button></div>
          <p class="demo-caption music-disclaimer">虚构曲目与歌词 · 无真实音乐输出</p>
        </template>

        <template v-if="panel === 'settings'">
          <section class="settings-section"><h3>与你交流的方式</h3><label class="field-label" for="assistant-name">助手称呼</label><input id="assistant-name" v-model="settings.assistantName" class="text-field" maxlength="30" /><label class="field-label" for="voice-style">声音（示意）</label><div class="voice-setting"><select id="voice-style" v-model="settings.voice" class="text-field"><option>温和男声</option><option>清澈女声</option><option>沉稳男声</option></select><button class="icon-button" :aria-label="previewingVoice ? '正在试听' : '试听示意声音'" data-tip="试听" @click="playVoicePreview"><Icon name="Volume2" :size="17" /></button></div><p class="demo-caption">试听使用系统语音，正式音色以后续接入为准。</p><details class="settings-advanced"><summary>更细的表达方式</summary><label class="field-label" for="persona-style">表达偏好</label><textarea id="persona-style" v-model="settings.style" class="text-field" rows="3" /></details><button class="primary-command" @click="saveSettings"><Icon name="Check" :size="15" />保存偏好</button></section>
          <section class="settings-section"><h3>记忆与感受</h3><div class="setting-line"><div><strong>记住重要的事</strong><small>自动记忆 · 原型开关</small></div><label class="switch"><input v-model="data.autoMemory" type="checkbox" aria-label="设置自动记忆" /><span /></label></div><div class="setting-line"><div><strong>减弱音乐动态</strong><small>保留粒子球的基础呼吸</small></div><label class="switch"><input v-model="data.reducedMotion" type="checkbox" aria-label="减弱音乐动态" /><span /></label></div><p class="settings-note">临时对话可在输入框下方开启；这段交流不会写入历史或读取记忆。</p></section>
          <section class="settings-section"><h3>服务状态</h3><div v-for="service in ['语音与对话', '联网搜索', '音乐音源']" :key="service" class="service-line"><span>{{ service }}</span><span>原型未连接</span></div></section>
        </template>

        <template v-if="panel === 'review'">
          <p class="review-intro">保留原有粒子主体，先走通交互，再连接真实能力。</p><div class="prototype-boundary"><Icon name="Monitor" :size="19" /><p>这是独立交互原型。回复、查询、歌曲和提醒均为示例；不会录音，不调用云端模型，也不影响正式应用。</p></div>
          <h3 class="review-section-title">六条核心链路</h3>
          <button v-for="scenario in [{ key: 'chat', icon: 'MessageCircle', name: '自然交流', desc: '倾诉、回应、打断' }, { key: 'memory', icon: 'Brain', name: '个人记忆', desc: '记住、更正、忘记' }, { key: 'search', icon: 'Globe', name: '联网查询', desc: '进度、候选、保存与提醒' }, { key: 'reminder', icon: 'NotebookPen', name: '生活小事', desc: '时间确认、修改、取消' }, { key: 'music', icon: 'Headphones', name: '音乐陪伴', desc: '后台播放、沉浸、队列' }, { key: 'work', icon: 'FileText', name: '轻工作协助', desc: '整理、编辑、保存、导出' }]" :key="scenario.key" class="scenario-button" @click="runScenario(scenario.key)"><Icon :name="scenario.icon" :size="19" /><span><strong>{{ scenario.name }}</strong><small>{{ scenario.desc }}</small></span><Icon name="ArrowRight" :size="16" /></button>
          <h3 class="review-section-title">连续委托与异常</h3><div class="review-secondary"><button @click="runScenario('combined')"><Icon name="CheckCheck" :size="15" />查询、记事与提醒</button><button @click="runScenario('partial')"><Icon name="BellOff" :size="15" />已保存，提醒失败</button><button @click="runScenario('failure')"><Icon name="RotateCcw" :size="15" />查询失败与重试</button><button @click="runScenario('continue')"><Icon name="History" :size="15" />接续上次的话题</button><button @click="runScenario('voiceDenied')"><Icon name="MicOff" :size="15" />麦克风未授权</button><button @click="runScenario('voiceSilent')"><Icon name="MicOff" :size="15" />没有识别到声音</button><button @click="runScenario('due')"><Icon name="Bell" :size="15" />模拟提醒到期</button></div><button class="text-command reset-command" @click="modal = { type: 'reset' }"><Icon name="RotateCcw" :size="15" />重置原型数据</button>
        </template>
      </div>
      <div v-if="['search', 'work'].includes(panel)" class="panel-prompt"><div v-if="voiceOpen" class="panel-voice"><input v-model="voiceDraft" aria-label="模拟识别文字" placeholder="输入模拟识别结果" @keydown.enter.prevent="sendVoice" /><button @click="sendVoice">发送</button><button aria-label="取消模拟语音" @click="cancelVoice"><Icon name="X" :size="15" /></button></div><form @submit.prevent="send()"><button type="button" aria-label="模拟语音输入" data-tip="模拟语音输入" @click="toggleVoice"><Icon name="Mic" :size="17" /></button><input v-model="input" aria-label="继续对话" :placeholder="panel === 'search' ? '继续调整条件或选择结果…' : '继续修改这份讨论稿…'" /><button type="submit" aria-label="发送消息" :disabled="!input.trim()"><Icon name="ArrowUp" :size="18" /></button></form></div>
      <footer class="panel-footer"><span class="tiny-square" />{{ panel === 'review' ? '先验收链路，再进入真实开发' : '原型数据与正式应用相互独立' }}</footer>
    </aside>

    <Transition name="toast"><div v-if="toast" class="toast-message" role="status"><Icon name="Check" :size="16" />{{ toast }}<button v-if="undoItem && toast.includes('可撤销')" @click="restoreItem">撤销</button></div></Transition>

    <div v-if="modal" class="modal-backdrop" @click.self="closeModal">
      <section ref="dialog" class="dialog" role="dialog" aria-modal="true" :aria-label="({ item: '编辑事项', reminder: '修改提醒', memory: '编辑记忆', confirmMemory: '保存临时对话的记忆', confirmSaveCandidate: '保存临时对话的结果', confirmSaveItem: '保存临时对话的事项', forget: '忘记这段记忆', deleteItem: '删除事项', source: '示例来源', reset: '重置原型' })[modal.type]" tabindex="-1" @keydown.tab="trapFocus">
        <button class="icon-button dialog-close" aria-label="关闭对话框" @click="closeModal"><Icon name="X" /></button>
        <form v-if="modal.type === 'item'" @submit.prevent="saveItem"><p class="overline">YOUR THINGS</p><h2>{{ modal.draft.id ? '把这件事理清楚' : '记下一件事' }}</h2><label class="field-label" for="item-title">事情</label><input id="item-title" v-model="modal.draft.title" class="text-field" required maxlength="120" /><details class="item-more" :open="Boolean(modal.draft.id || modal.draft.body || modal.draft.reminder)"><summary>补充内容与提醒</summary><label class="field-label" for="item-body">补充内容</label><textarea id="item-body" v-model="modal.draft.body" class="text-field" rows="3" /><div class="form-columns"><label>类型<select v-model="modal.draft.kind" class="text-field" aria-label="事项类型"><option>待办</option><option>记录</option></select></label><label>提醒时间<input v-model="modal.draft.reminder" class="text-field" type="datetime-local" aria-label="提醒时间" /></label></div><button v-if="modal.draft.reminder" class="text-command muted" type="button" @click="modal.draft.reminder = ''"><Icon name="Bell" :size="13" />取消这条提醒</button><p class="demo-caption">模拟提醒，不会发送系统通知。</p></details><div class="dialog-actions"><button v-if="modal.draft.kind === '待办' && modal.draft.id" class="text-command" type="button" @click="startFocus(modal.draft.title); closeModal()"><Icon name="Timer" :size="15" />开始专注</button><button class="secondary-command" type="button" @click="closeModal">取消</button><button class="primary-command" type="submit"><Icon name="Check" :size="15" />保存</button></div></form>
        <form v-else-if="modal.type === 'reminder'" @submit.prevent="saveReminder"><p class="overline">ONE THING</p><h2>{{ modal.title }}</h2><label class="field-label" for="reminder-time">提醒时间</label><input id="reminder-time" v-model="modal.reminder" class="text-field" type="datetime-local" /><p class="demo-caption">模拟提醒，不会发送系统通知。</p><div class="dialog-actions"><button v-if="modal.reminder" class="text-command muted" type="button" @click="modal.reminder = ''; saveReminder()">取消提醒</button><button class="secondary-command" type="button" @click="closeModal">返回</button><button class="primary-command" type="submit">保存时间</button></div></form>
        <form v-else-if="modal.type === 'memory'" @submit.prevent="saveMemory"><p class="overline">ABOUT YOU</p><h2>{{ modal.draft.id ? '以现在的你为准' : '有件事，想让你记住' }}</h2><label class="field-label" for="memory-content">内容</label><textarea id="memory-content" v-model="modal.draft.text" class="text-field" rows="4" required /><label class="field-label" for="memory-category">归类</label><select id="memory-category" v-model="modal.draft.category" class="text-field"><option>偏好</option><option>近况</option><option>共同结论</option></select><div class="dialog-actions"><button class="secondary-command" type="button" @click="closeModal">取消</button><button class="primary-command" type="submit"><Icon name="Check" :size="15" />保存记忆</button></div></form>
        <template v-else-if="modal.type === 'forget'"><p class="overline">YOUR CHOICE</p><h2>忘记这段记忆？</h2><p class="confirmation-copy">{{ modal.title }}</p><p class="dialog-description">不再用于后续对话。已保存的事项和历史记录不受影响。</p><div class="dialog-actions"><button class="secondary-command" @click="closeModal">保留</button><button class="danger-command" @click="confirmDelete"><Icon name="Trash2" :size="15" />忘记</button></div></template>
        <template v-else-if="modal.type === 'deleteItem'"><p class="overline">YOUR THINGS</p><h2>删除这件事？</h2><p class="confirmation-copy">{{ modal.title }}</p><p v-if="modal.reminder" class="dialog-description">关联的 {{ displayDate(modal.reminder) }} 提醒也将取消。</p><div class="dialog-actions"><button class="secondary-command" @click="closeModal">保留</button><button class="danger-command" @click="confirmDelete"><Icon name="Trash2" :size="15" />删除{{ modal.reminder ? '并取消提醒' : '' }}</button></div></template>
        <template v-else-if="modal.type === 'confirmMemory'"><h2>保存这件事？</h2><p class="confirmation-copy">{{ modal.text }}</p><p class="dialog-description">当前是临时对话。确认后将退出临时对话，并把这段内容保存到长期记忆。</p><div class="dialog-actions"><button class="secondary-command" @click="closeModal">继续临时对话</button><button class="primary-command" @click="confirmRemember">确认保存</button></div></template>
        <template v-else-if="modal.type === 'confirmSaveCandidate'"><h2>保存这个结果？</h2><p class="dialog-description">当前是临时对话。确认后将退出临时对话，并把选中的去处保存到「手边的事」。</p><div class="dialog-actions"><button class="secondary-command" @click="closeModal">继续临时对话</button><button class="primary-command" @click="confirmCandidateSave">确认保存</button></div></template>
        <template v-else-if="modal.type === 'confirmSaveItem'"><h2>保存这件事？</h2><p class="confirmation-copy">{{ modal.draft.title }}</p><p class="dialog-description">当前是临时对话。确认后将退出临时对话，并把这件事保存到「手边的事」。</p><div class="dialog-actions"><button class="secondary-command" @click="closeModal">继续临时对话</button><button class="primary-command" @click="confirmItemSave">确认保存</button></div></template>
        <template v-else-if="modal.type === 'source'"><p class="overline">SOURCE / SAMPLE</p><h2>{{ selectedSource.title }}</h2><p class="confirmation-copy">{{ selectedSource.text }}</p><p class="dialog-description">{{ selectedSource.source }}。正式版此处应展示对应结论的真实来源、访问时间和可打开的链接。</p><div class="source-sample"><span>来源类型</span><strong>原型占位</strong><span>事实核验</span><strong>未执行</strong></div><div class="dialog-actions"><button class="primary-command" @click="closeModal">返回结果</button></div></template>
        <template v-else-if="modal.type === 'reset'"><h2>重新体验一遍？</h2><p class="dialog-description">仅清空这个原型中的演示记录、设置和播放状态，恢复初始示例。正式应用不受影响。</p><div class="dialog-actions"><button class="secondary-command" @click="closeModal">取消</button><button class="danger-command" @click="reset"><Icon name="RotateCcw" :size="15" />重置原型</button></div></template>
      </section>
    </div>
  </div>
</template>
