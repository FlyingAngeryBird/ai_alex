import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { displayDate, initialReply, searchCandidates, seedItems, seedMemories, seedTopics, tomorrowAt, tracks } from './fixtures'

const storageKey = 'seamo-r1-interaction-prototype-v1'
const clone = value => JSON.parse(JSON.stringify(value))
const uid = () => globalThis.crypto.randomUUID()

function demoReminderTime(text) {
  const match = text.match(/(\d{1,2})点(?:(\d{1,2})分?|半)?/)
  if (!/明天|明晚/.test(text) || !match) return ''
  let hour = Number(match[1])
  const minute = match[2] ? Number(match[2]) : match[0].endsWith('半') ? 30 : 0
  if (hour > 23 || minute > 59) return ''
  if (/晚上|明晚|下午/.test(text) && hour < 12) hour += 12
  return tomorrowAt(hour, minute)
}

function initialData() {
  return {
    assistantName: 'Seamo AI', voice: '温和男声', style: '自然、温暖，先听我说完。',
    autoMemory: false, reducedMotion: false, volume: 65, workDraft: null,
    memories: clone(seedMemories), topics: clone(seedTopics), items: clone(seedItems), favorites: ['forest'], lessMusic: [], history: []
  }
}

function readSaved() {
  const fallback = initialData()
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
    if (!saved || !Array.isArray(saved.memories) || !Array.isArray(saved.items)) return fallback
    return { ...fallback, ...saved, topics: Array.isArray(saved.topics) ? saved.topics : fallback.topics, lessMusic: Array.isArray(saved.lessMusic) ? saved.lessMusic : [] }
  } catch { return fallback }
}

export function usePrototype() {
  const data = reactive(readSaved())
  const latestUser = [...data.history].reverse().find(message => message.role === 'user')
  const latestAssistant = [...data.history].reverse().find(message => message.role === 'assistant')
  const view = ref('home')
  const panel = ref('')
  const input = ref('')
  const reply = ref(latestAssistant?.text || initialReply)
  const lastUser = ref(latestUser?.text || '')
  const phase = ref('idle')
  const temporary = ref(false)
  const result = ref(data.workDraft?.generated && !data.workDraft.saved ? { type: 'work' } : null)
  const toast = ref('')
  const modal = ref(null)
  const voiceDraft = ref('今天有点累，陪我聊会儿。')
  const voiceOpen = ref(false)
  const voiceIssue = ref('')
  const memoryFilter = ref('关于我')
  const memoryTopicId = ref('')
  const memoryQuery = ref('')
  const itemFilter = ref('待办')
  const itemQuery = ref('')
  const selectedCandidateId = ref('')
  const excludedCandidateIds = ref([])
  const historyTopicId = ref('')
  const activeTopicId = ref(data.history.at(-1)?.topicId || 'seamo-plan')
  const undoItem = ref(null)
  const job = ref(null)
  const searchQuery = ref('周末想找个安静的地方走走')
  const nextSearchFails = ref(false)
  const musicTab = ref('发现')
  const musicQuery = ref('')
  const musicSource = ref('all')
  const musicSearched = ref(false)
  const trackId = ref('slow-tide')
  const musicStarted = ref(false)
  const playing = ref(false)
  const position = ref(0)
  const queue = ref(tracks.map(track => track.id))
  const focus = reactive({ duration: 25, remaining: 25 * 60, active: false, paused: false, taskTitle: '' })
  const editor = reactive({ title: '', body: '', id: '', input: '', generated: false, saved: false, previousBody: '', selection: '', ...data.workDraft })
  const settings = reactive({ assistantName: data.assistantName, voice: data.voice, style: data.style })
  const bands = reactive({ bass: 0, beat: 0, centroid: 0.32, flux: 0, mid: 0, treble: 0 })
  const audioLevel = ref(0)
  const seen = ref(Boolean(latestUser))
  let turn = 0
  let taskGeneration = 0
  let responseTimer = 0
  let toastTimer = 0
  let taskTimers = []
  let pointerHolding = false
  let disposed = false
  let lastTick = performance.now()
  let storageFailed = false

  const currentTrack = computed(() => tracks.find(track => track.id === trackId.value) || tracks[0])
  const particleState = computed(() => phase.value !== 'idle' ? phase.value : playing.value ? 'playing' : 'idle')
  const statusLabel = computed(() => ({ idle: '在这里', listening: '模拟聆听', thinking: '正在整理', speaking: '模拟回应' })[phase.value])
  const filteredMemories = computed(() => data.memories.filter(memory =>
    memory.text.includes(memoryQuery.value)))
  const filteredTopics = computed(() => data.topics.filter(topic =>
    `${topic.title} ${topic.current} ${topic.events.map(event => event.text).join(' ')}`.includes(memoryQuery.value)))
  const filteredItems = computed(() => data.items.filter(item =>
    item.kind === itemFilter.value &&
    `${item.title} ${item.body}`.includes(itemQuery.value)))
  const groupedItems = computed(() => {
    if (itemFilter.value === '记录') return [{ title: '最近留下的记录', entries: filteredItems.value }]
    const today = new Date().toDateString()
    return [
      { title: '今天', entries: filteredItems.value.filter(item => !item.done && item.reminder && new Date(item.reminder).toDateString() === today) },
      { title: '之后', entries: filteredItems.value.filter(item => !item.done && item.reminder && new Date(item.reminder).toDateString() !== today) },
      { title: '未定时间', entries: filteredItems.value.filter(item => !item.done && !item.reminder) },
      { title: '已完成', entries: filteredItems.value.filter(item => item.done) }
    ].filter(group => group.entries.length)
  })
  const historyGroups = computed(() => {
    const groups = []
    for (const message of data.history) {
      let group = groups.find(entry => entry.id === (message.topicId || 'other'))
      if (!group) { group = { id: message.topicId || 'other', messages: [] }; groups.push(group) }
      group.messages.push(message)
    }
    return groups.map(group => ({ ...group, title: data.topics.find(topic => topic.id === group.id)?.title || '日常对话', latest: group.messages.at(-1)?.time || '' })).reverse()
  })
  const searchOptions = computed(() => searchCandidates.filter(candidate => !excludedCandidateIds.value.includes(candidate.id)))
  const foundTracks = computed(() => tracks.filter(track => {
    if (musicTab.value === '收藏') return data.favorites.includes(track.id)
    if (musicTab.value === '队列') return queue.value.includes(track.id)
    return (musicSource.value === 'all' || track.source === musicSource.value) &&
      (!musicQuery.value.trim() || `${track.title} ${track.artist} ${track.album}`.includes(musicQuery.value.trim()))
  }).sort((a, b) => musicTab.value === '队列' ? queue.value.indexOf(a.id) - queue.value.indexOf(b.id) : 0))
  const lyricIndex = computed(() => Math.min(currentTrack.value.lyrics.length - 1,
    Math.floor(position.value / currentTrack.value.duration * currentTrack.value.lyrics.length)))
  const outstandingCount = computed(() => data.items.filter(item => item.kind === '待办' && !item.done).length)

  function notify(message) {
    toast.value = message
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => { toast.value = '' }, 3200)
  }

  watch(data, () => {
    try { localStorage.setItem(storageKey, JSON.stringify(data)) }
    catch {
      if (!storageFailed) notify('浏览器无法保存，本次改动仅在当前窗口保留。')
      storageFailed = true
    }
  }, { deep: true })

  watch(editor, () => {
    data.workDraft = editor.generated ? { title: editor.title, body: editor.body, id: editor.id, input: editor.input, generated: editor.generated, saved: editor.saved, previousBody: editor.previousBody } : null
  }, { deep: true })

  function openPanel(name) {
    panel.value = panel.value === name ? '' : name
    if (name === 'settings') Object.assign(settings, { assistantName: data.assistantName, voice: data.voice, style: data.style })
  }

  function record(role, text) {
    if (!temporary.value) data.history.push({ id: uid(), role, text, topicId: activeTopicId.value || 'other', time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) })
    if (data.history.length > 80) data.history.splice(0, data.history.length - 80)
  }

  function interrupt() {
    turn += 1
    clearTimeout(responseTimer)
    phase.value = 'idle'
  }

  function respond(text, delay = 420, saveToHistory = true) {
    const token = ++turn
    clearTimeout(responseTimer)
    phase.value = 'thinking'
    responseTimer = window.setTimeout(() => {
      if (token !== turn || disposed) return
      reply.value = text
      if (saveToHistory) record('assistant', text)
      phase.value = 'speaking'
      responseTimer = window.setTimeout(() => { if (token === turn) phase.value = 'idle' }, 1600)
    }, delay)
  }

  function addMemory(text, category = '偏好', saveReplyToHistory = true) {
    const cleaned = text.replace(/^.*?记住[：:，,\s]*/, '').trim()
    if (!cleaned) return
    const existing = data.memories.find(memory => memory.text === cleaned)
    if (!existing) data.memories.unshift({ id: uid(), text: cleaned, category, source: `你说：${text}`, updated: '刚刚', enabled: true })
    result.value = { type: 'memory', title: cleaned, id: existing?.id || data.memories[0].id }
    respond(existing ? '这件事已经记着了，没有重复添加。' : '记住了。之后聊到相关事情，我会以这个为准。', 420, saveReplyToHistory)
  }

  function continueTopic(id) {
    const topic = data.topics.find(entry => entry.id === id)
    if (!topic) return
    activeTopicId.value = id
    memoryTopicId.value = id
    panel.value = ''
    view.value = 'home'
    send(`接着「${topic.title}」聊`)
  }

  function updateTopic(id, current, eventText = current) {
    const topic = data.topics.find(entry => entry.id === id)
    if (!topic) return
    topic.current = current
    topic.updated = '刚刚'
    topic.events.push({ id: uid(), when: '刚刚', text: eventText })
  }

  function saveCandidate(candidate) {
    if (temporary.value) {
      modal.value = { type: 'confirmSaveCandidate', candidateId: candidate.id, withReminder: false }
      return null
    }
    selectedCandidateId.value = candidate.id
    const workflow = job.value?.workflow
    const chainPending = workflow && !workflow.itemId
    const existing = data.items.find(item => item.sourceId === candidate.id)
    if (existing && !chainPending) { notify('这条已经记下了'); return existing }
    const item = existing || { id: uid(), title: candidate.title, body: candidate.text, kind: '记录', done: false, reminder: '', created: '刚刚', sourceId: candidate.id }
    if (!existing) data.items.unshift(item)
    if (!temporary.value) {
      if (!data.topics.some(topic => topic.id === 'weekend-plan')) data.topics.unshift({ id: 'weekend-plan', title: '周末安静的去处', current: '', updated: '刚刚', events: [] })
      updateTopic('weekend-plan', `已选「${candidate.title}」。`, `选择并记下「${candidate.title}」。`)
    }
    if (chainPending) {
      const stored = data.items.find(entry => entry.id === item.id)
      workflow.selectedId = candidate.id
      if (!workflow.reminder) {
        openItem(stored)
        modal.value.draft.workflowJobId = job.value.id
        respond('选好的去处记下了。你希望哪天、几点收到提醒？')
        return stored
      }
      stored.reminder = workflow.reminder
      workflow.itemId = item.id
      if (!temporary.value) updateTopic('weekend-plan', `已记下「${candidate.title}」，并约好提醒。`)
      result.value = { type: 'item', id: item.id, title: item.title }
      respond(`选好的「${item.title}」记下了，也加上了 ${displayDate(workflow.reminder)} 的提醒。`)
      notify('组合委托已完成 · 原型模拟提醒')
    } else notify('已保存到原型的事项中')
    return item
  }

  function confirmCandidateSave() {
    const candidate = searchCandidates.find(entry => entry.id === modal.value?.candidateId)
    const withReminder = modal.value?.withReminder
    if (!candidate) return
    temporary.value = false
    activeTopicId.value = 'weekend-plan'
    modal.value = null
    const item = saveCandidate(candidate)
    if (withReminder && item && modal.value?.type !== 'item') openItem(item)
  }

  function clearTaskTimers() {
    taskTimers.forEach(clearTimeout)
    taskTimers = []
  }

  function search(query = searchQuery.value, resume = false, workflow = null) {
    if (!query.trim()) return
    clearTaskTimers()
    const generation = ++taskGeneration
    const shouldFail = nextSearchFails.value
    nextSearchFails.value = false
    searchQuery.value = query
    if (!resume) { selectedCandidateId.value = ''; excludedCandidateIds.value = [] }
    activeTopicId.value = 'weekend-plan'
    if (!temporary.value && data.autoMemory && !data.topics.some(topic => topic.id === 'weekend-plan')) data.topics.unshift({ id: 'weekend-plan', title: '周末安静的去处', current: '正在寻找合适的地方。', updated: '刚刚', events: [{ id: uid(), when: '刚刚', text: `想找：${query}` }] })
    job.value = { id: resume && job.value ? job.value.id : uid(), title: query, status: 'running', step: 0, query, workflow: workflow || (resume ? job.value?.workflow : null) }
    result.value = { type: 'search' }
    respond('我先按你的条件看看，留两个选择就好。你也可以接着说。', 180)
    const announcementTurn = turn
    taskTimers.push(window.setTimeout(() => {
      if (generation === taskGeneration && job.value?.status === 'running') job.value.step = 1
    }, 1100))
    taskTimers.push(window.setTimeout(() => {
      if (generation !== taskGeneration || disposed) return
      job.value.status = shouldFail ? 'error' : 'done'
      job.value.step = shouldFail ? 1 : 2
      if (!shouldFail && !temporary.value && data.autoMemory) updateTopic('weekend-plan', '已找到两个候选，等你挑选。')
      if (phase.value === 'idle' && turn === announcementTurn) respond(shouldFail
        ? '这次没有拿到结果。你的条件还在，可以重新试一次。'
        : job.value.workflow && !job.value.workflow.itemId
          ? job.value.workflow.reminder
            ? `找到了两个示例。选好一个后，我会记下，并加上 ${displayDate(job.value.workflow.reminder)} 的提醒。`
            : '找到了两个示例。选好一个后，我会记下，再和你确认提醒时间。'
          : '整理了两个不同节奏的去处。你想走走，还是找个地方安静坐坐？', 80)
    }, 3200))
  }

  function controlJob(action) {
    if (!job.value) return
    if (action === 'resume') { search(job.value.query, true); return }
    clearTaskTimers()
    taskGeneration += 1
    job.value.status = action === 'pause' ? 'paused' : 'cancelled'
    notify(action === 'pause' ? '已暂停，可以稍后继续' : '已取消，已有记录不受影响')
  }

  function playTrack(id = trackId.value) {
    if (trackId.value !== id) position.value = 0
    if (!queue.value.includes(id)) queue.value.push(id)
    trackId.value = id
    musicStarted.value = true
    playing.value = true
  }

  function toggleMusic() {
    if (!musicStarted.value) playTrack()
    else playing.value = !playing.value
  }

  function skip(direction) {
    const index = queue.value.indexOf(trackId.value)
    const next = queue.value[index + direction]
    if (!next) { notify(direction > 0 ? '已经是队列中的最后一首' : '已经是第一首'); return }
    position.value = 0
    playTrack(next)
  }

  function favorite(id) {
    const index = data.favorites.indexOf(id)
    if (index < 0) data.favorites.push(id)
    else data.favorites.splice(index, 1)
  }

  function moveQueue(id, direction) {
    const index = queue.value.indexOf(id)
    const next = index + direction
    if (next < 0 || next >= queue.value.length) return
    const copy = [...queue.value]
    ;[copy[index], copy[next]] = [copy[next], copy[index]]
    queue.value = copy
  }

  function openItem(item = null, reminderOnly = false) {
    modal.value = { type: 'item', draft: item ? clone(item) : {
      id: '', title: '', body: '', kind: '待办', done: false, reminder: reminderOnly ? tomorrowAt() : '', created: '刚刚'
    } }
  }

  function openReminder(item) {
    modal.value = { type: 'reminder', id: item.id, title: item.title, reminder: item.reminder || '' }
  }

  function saveReminder() {
    const item = data.items.find(entry => entry.id === modal.value?.id)
    if (!item) return
    const reminder = modal.value.reminder
    if (reminder && new Date(reminder).getTime() <= Date.now()) { notify('提醒时间需要晚于现在'); return }
    item.reminder = reminder
    item.reminderPending = false
    modal.value = null
    notify(reminder ? `已改为 ${displayDate(reminder)} 提醒` : '这条提醒已取消，记录仍保留')
  }

  function saveItem() {
    const draft = modal.value?.draft
    if (!draft?.title.trim()) { notify('先写下这件事的名称'); return }
    if (draft.reminder && new Date(draft.reminder).getTime() <= Date.now()) { notify('提醒时间需要晚于现在'); return }
    if (temporary.value && !modal.value?.confirmed) { modal.value = { type: 'confirmSaveItem', draft: clone(draft) }; return }
    const item = { ...draft, id: draft.id || uid(), title: draft.title.trim(), reminderPending: draft.reminder ? false : Boolean(draft.reminderPending), delivered: false }
    const index = data.items.findIndex(existing => existing.id === item.id)
    if (index < 0) data.items.unshift(item)
    else data.items.splice(index, 1, item)
    if (draft.workflowJobId === job.value?.id && item.reminder && job.value?.workflow) {
      job.value.workflow.itemId = item.id
      job.value.workflow.reminder = item.reminder
    }
    result.value = { type: 'item', id: item.id, title: item.title }
    modal.value = null
    notify(item.reminder ? `已保存 · ${displayDate(item.reminder)}（模拟提醒）` : '已保存到原型的事项中')
  }

  function confirmItemSave() {
    const draft = clone(modal.value?.draft)
    if (!draft) return
    temporary.value = false
    modal.value = { type: 'item', draft, confirmed: true }
    saveItem()
  }

  function toggleItem(item) {
    undoItem.value = { id: item.id, done: item.done, reminder: item.reminder }
    item.done = !item.done
    if (item.done) item.reminder = ''
    notify(item.done ? '已完成，提醒已取消 · 可撤销' : '已恢复为待办 · 可撤销')
  }

  function restoreItem() {
    const item = data.items.find(entry => entry.id === undoItem.value?.id)
    if (item) Object.assign(item, { done: undoItem.value.done, reminder: undoItem.value.reminder })
    undoItem.value = null
    toast.value = ''
  }

  function completeItem(cancelReminder) {
    const item = data.items.find(entry => entry.id === modal.value?.id)
    if (item) { item.done = true; if (cancelReminder) item.reminder = '' }
    modal.value = null
    notify(cancelReminder ? '已完成，关联提醒已取消' : '已完成，提醒仍保留')
  }

  function deleteItem(item) {
    modal.value = { type: 'deleteItem', id: item.id, title: item.title, reminder: item.reminder }
  }

  function confirmDelete() {
    if (modal.value?.type === 'deleteItem') {
      data.items = data.items.filter(item => item.id !== modal.value.id)
      notify('已删除事项及其关联提醒')
    } else if (modal.value?.type === 'forget') {
      data.memories = data.memories.filter(memory => memory.id !== modal.value.id)
      notify('已从原型记忆中移除')
    }
    modal.value = null
  }

  function editMemory(memory) { modal.value = { type: 'memory', draft: clone(memory) } }

  function saveMemory() {
    const draft = modal.value?.draft
    if (!draft?.text.trim()) { notify('记忆内容不能为空'); return }
    const index = data.memories.findIndex(memory => memory.id === draft.id)
    const memory = { ...draft, text: draft.text.trim(), id: draft.id || uid(), updated: '刚刚', source: '你在记忆页确认的内容。', enabled: true }
    if (index < 0) data.memories.unshift(memory)
    else data.memories.splice(index, 1, memory)
    modal.value = null
    notify('已更新，下一轮以新内容为准')
  }

  function toggleTemporary() {
    interrupt()
    temporary.value = !temporary.value
    lastUser.value = ''
    panel.value = ''
    view.value = 'home'
    result.value = !temporary.value && editor.generated && !editor.saved ? { type: 'work' } : null
    activeTopicId.value = temporary.value ? '' : 'seamo-plan'
    reply.value = temporary.value ? '这段对话只留在这里，不读取已有记忆。' : '回到普通对话了。我在。'
    notify(temporary.value ? '已进入临时对话' : '临时对话已结束')
  }

  function startFocus(title = '') {
    focus.taskTitle = title
    focus.duration = Math.max(1, Math.min(120, Number(focus.duration) || 25))
    focus.remaining = focus.duration * 60
    focus.active = true
    focus.paused = false
    lastTick = performance.now()
    notify(`${focus.duration} 分钟，从现在开始${title ? ` · ${title}` : ''}`)
  }

  function generateWork(short = false) {
    if (!editor.input.trim()) editor.input = '先实现 Seamo 的核心功能，再升级界面。重点验证聊天、记忆、联网、事项和音乐之间能顺畅衔接。'
    if (editor.generated) editor.previousBody = editor.body
    editor.title = '下一步，先把链路跑通'
    editor.body = short
      ? `目标\n${editor.input.trim()}\n\n下一步\n选择一个完整使用场景，确认输入、行动、结果与修改方式。`
      : `当前目标\n${editor.input.trim()}\n\n先做什么\n1. 明确用户从哪里开始，以及希望得到什么。\n2. 把回应、执行结果和必要确认连接起来。\n3. 验证失败后可以重试，修改后不会丢失已有内容。\n\n完成标准\n从提出请求到得到结果，不需要重新解释背景；结果可以继续修改或取消。`
    editor.generated = true
    editor.saved = false
    result.value = { type: 'work' }
    respond('先把要解决的事情和下一步分开了。你可以直接改，也可以让我再压缩一点。')
  }

  function reviseWork(instruction) {
    if (!editor.generated) return false
    editor.previousBody = editor.body
    const parts = editor.body.split('\n\n')
    const selected = instruction.match(/第\s*([一二三四五六七八九1-9])\s*段/)
    const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
    const index = selected ? (digits[selected[1]] || Number(selected[1])) - 1 : -1
    if (index >= 0 && index < parts.length) {
      parts[index] = parts[index].split('\n').slice(0, 2).join('\n')
      editor.body = parts.join('\n\n')
      respond(`第 ${index + 1} 段已缩短，其他内容保持原样。`)
    } else if (/简短|压缩|精简/.test(instruction)) {
      editor.body = parts.map(part => part.split('\n').slice(0, 2).join('\n')).join('\n\n')
      respond('先压缩了篇幅，你可以继续调整。')
    } else {
      editor.previousBody = ''
      return false
    }
    editor.saved = false
    return true
  }

  function undoWork() {
    if (!editor.previousBody) return
    editor.body = editor.previousBody
    editor.previousBody = ''
    editor.saved = false
    notify('已恢复上一次版本')
  }

  function saveWork() {
    if (!editor.body.trim()) { notify('还没有可保存的内容'); return }
    const item = { id: editor.id || uid(), title: editor.title.trim() || '未命名记录', body: editor.body, kind: '记录', done: false, reminder: '', created: '刚刚' }
    const index = data.items.findIndex(entry => entry.id === item.id)
    if (index < 0) data.items.unshift(item)
    else data.items.splice(index, 1, { ...data.items[index], ...item })
    editor.id = item.id
    editor.saved = true
    if (!temporary.value) updateTopic('seamo-plan', `已整理讨论稿「${item.title}」。`, `保存了讨论稿「${item.title}」。`)
    notify('已保存为记录，后续保存会更新同一条')
  }

  async function copyWork() {
    try { await navigator.clipboard.writeText(`${editor.title}\n\n${editor.body}`); notify('已复制') }
    catch { notify('浏览器未允许复制，请在正文中选择文字复制') }
  }

  function exportWork() {
    const url = URL.createObjectURL(new Blob([`# ${editor.title}\n\n${editor.body}`], { type: 'text/markdown;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'Seamo-原型讨论记录.md'
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    notify('已发起 Markdown 下载')
  }

  function saveSettings() {
    data.assistantName = settings.assistantName.trim() || 'Seamo AI'
    data.voice = settings.voice
    data.style = settings.style
    notify('原型设置已保存')
  }

  function startVoice() {
    interrupt()
    phase.value = 'listening'
    voiceOpen.value = true
    voiceIssue.value = ''
    voiceDraft.value = ''
  }

  function closeModal() {
    modal.value = null
  }

  function sendVoice() {
    const text = voiceDraft.value.trim()
    if (!text) { voiceIssue.value = '原型没有连接麦克风。请在这里输入一句话模拟识别结果。'; return }
    voiceOpen.value = false
    voiceIssue.value = ''
    send(text)
  }

  function cancelVoice() {
    voiceOpen.value = false
    voiceIssue.value = ''
    phase.value = 'idle'
  }

  function send(value = input.value) {
    const text = value.trim()
    if (!text) return
    interrupt()
    voiceOpen.value = false
    input.value = ''
    lastUser.value = text
    seen.value = true
    if (/周末|去处|展览/.test(text)) activeTopicId.value = 'weekend-plan'
    else if (/产品|方案|链路/.test(text)) activeTopicId.value = 'seamo-plan'
    else if (job.value && /(这个|第二个|选中|提醒|保存)/.test(text)) activeTopicId.value = 'weekend-plan'
    else if (panel.value === 'work' && editor.generated) activeTopicId.value = 'seamo-plan'
    else activeTopicId.value = 'other'
    record('user', text)
    if (/取消.*(查询|搜索|任务)|别查了/.test(text)) { controlJob('cancel'); respond('好，这次查询停在这里。'); return }
    if (/先别提醒|取消提醒/.test(text)) {
      const item = data.items.find(entry => entry.id === job.value?.workflow?.itemId || entry.id === result.value?.id)
      if (item?.reminder) { item.reminder = ''; respond(`好，「${item.title}」还留着，提醒已取消。`) }
      else respond('目前没有待取消的提醒，已经记下的内容会保留。')
      return
    }
    if (job.value?.status === 'done' && selectedCandidateId.value && /太远|不要这个|换一个/.test(text)) {
      excludedCandidateIds.value = [...new Set([...excludedCandidateIds.value, selectedCandidateId.value])]
      selectedCandidateId.value = ''
      panel.value = 'search'
      respond(searchOptions.value.length ? '先排除刚才那个。另一个候选还在这里，你想看看吗？' : '这两个都排除了。可以换个条件再找。')
      return
    }
    if (panel.value === 'work' && editor.generated && reviseWork(text)) return
    if (/(查|找|搜索).*(记下|保存).*提醒/.test(text)) {
      search(text, false, { reminder: demoReminderTime(text), itemId: null, selectedId: null })
    } else if (/(第二个|这个|选中的).*(记|保存)|把第二个/.test(text) && job.value?.status === 'done') {
      const chainPending = job.value.workflow && !job.value.workflow.itemId
      const candidate = /第二个/.test(text) ? searchOptions.value[1] : searchCandidates.find(entry => entry.id === selectedCandidateId.value)
      if (!candidate) { respond('先选一个结果，我再把它记下来。'); return }
      const item = saveCandidate(candidate)
      if (!item) { respond('现在是临时对话。确认后我再把它保存。'); return }
      result.value = { type: 'item', title: item.title, id: item.id }
      if (!chainPending) respond(`把「${candidate.title}」记下来了。想再看时，不用重新找。`)
    } else if (/记住/.test(text)) {
      if (temporary.value) { result.value = { type: 'temporaryMemory', text }; respond('现在是临时对话。要先回到普通对话，再记住这件事吗？') }
      else addMemory(text)
    } else if (/忘记|忘掉/.test(text)) {
      if (temporary.value) { respond('临时对话不读取已有记忆。回到普通对话后，再确认要忘记哪一条。'); return }
      panel.value = 'memory'
      respond('这里是目前保留的记忆。选中要忘记的那一条，就可以移除。')
    } else if (/提醒|明天.*记得/.test(text)) {
      const title = text.replace(/明天|明晚|晚上|提醒我|提醒|[0-9]+点/g, '').replace(/^[，,\s]+/, '').trim() || '接着今天的方案'
      openItem(null, true)
      modal.value.draft.title = title
      modal.value.draft.reminder = demoReminderTime(text)
      if (modal.value.draft.reminder) {
        const when = displayDate(modal.value.draft.reminder)
        saveItem()
        respond(`记好了，${when}，${title}。时间和内容都可以继续修改。`)
      } else respond('你想在哪天、几点收到提醒？确定时间后，我再把这件事记好。')
    } else if (/暂停.*(音乐|播放)|音乐.*暂停/.test(text)) {
      playing.value = false; respond('好，先暂停。')
    } else if (/放.*音乐|播放|听.*歌|放.*歌/.test(text)) {
      const prefersInstrumental = !temporary.value && data.memories.some(memory => memory.enabled && /无歌词|没有歌词|纯音乐/.test(memory.text))
      const recommended = prefersInstrumental ? 'forest' : tracks.find(track => !data.lessMusic.includes(track.id))?.id || 'slow-tide'
      playTrack(recommended)
      respond(prefersInstrumental ? '沿用你工作时喜欢的纯音乐，先放一段轻一点的。我们可以继续聊。' : '先放一段舒缓的旋律，我们可以继续聊。')
    } else if (/专注|计时/.test(text)) {
      focus.duration = Number(text.match(/(\d+)分钟/)?.[1] || 25)
      startFocus(); respond(`好，留 ${focus.duration} 分钟给眼前的事。`)
    } else if (/查|搜索|周末|展览|去处|联网/.test(text)) {
      search(text)
    } else if (/记下来|记下|保存这/.test(text)) {
      openItem()
      modal.value.draft.kind = '记录'
      modal.value.draft.title = text.replace(/帮我|记下来|记下|保存这|[：:]/g, '').trim() || '刚才的想法'
      if (modal.value.draft.title !== '刚才的想法' && !/^(这个|这件事)$/.test(modal.value.draft.title)) {
        saveItem()
        respond('记下来了。之后想继续改，我们就接着这一条。')
      } else respond('想记下哪一部分？把内容补在这里就好。')
    } else if (/接着「/.test(text)) {
      const topic = data.topics.find(entry => text.includes(entry.title))
      respond(topic ? `上次停在这里：${topic.current} 你想从哪一部分继续？` : '你想接着哪一件事聊？')
    } else if (/昨天|上次/.test(text)) {
      const memory = !temporary.value && data.memories.find(entry => entry.category === '共同结论' && entry.enabled)
      respond(memory ? `上次我们定下的是：${memory.text} 今天想先从哪一条链路开始？` : '这段对话里还没有那件事的背景。你可以告诉我想接着哪一件事聊。')
    } else if (/整理|思路|方案|改写|总结/.test(text)) {
      editor.id = ''
      editor.input = text
      generateWork()
    } else if (/你叫|你是谁|名字/.test(text)) {
      respond(`我是 ${data.assistantName}。你可以和我聊聊，也可以一起把眼前的小事理顺。`)
    } else if (/累|烦|难过|安静|不.*建议|只想聊/.test(text)) {
      respond(/安静|待会|待一会/.test(text) ? '好，我们就安静待一会儿。想说话的时候，我在。' : '听起来今天消耗了不少力气。不急着想办法，你想从哪一小段说起？')
    } else {
      respond('嗯，我在听。你可以慢慢说，不用一下子整理清楚。')
    }
  }

  function continueRemember() {
    const text = result.value?.text
    if (text) modal.value = { type: 'confirmMemory', text }
  }

  function confirmRemember() {
    const text = modal.value?.text
    modal.value = null
    temporary.value = false
    if (text) addMemory(text, '偏好', false)
  }

  function previewDue() {
    result.value = { type: 'due', title: '接着昨天的产品方案' }
    view.value = 'home'
    panel.value = ''
    notify('模拟到期提醒，不触发系统通知')
  }

  function previewPartial() {
    if (temporary.value) { notify('先结束临时对话，再演示已保存的事项'); return }
    const candidate = searchCandidates[0]
    lastUser.value = '把湖边的去处记下来，明晚提醒我。'
    activeTopicId.value = 'weekend-plan'
    seen.value = true
    record('user', lastUser.value)
    let item = data.items.find(entry => entry.sourceId === candidate.id)
    if (!item) {
      item = { id: uid(), title: candidate.title, body: candidate.text, kind: '记录', done: false, reminder: '', created: '刚刚', sourceId: candidate.id }
      data.items.unshift(item)
    }
    item.reminder = ''
    item.reminderPending = true
    result.value = { type: 'item', id: item.id, title: item.title }
    panel.value = 'items'
    view.value = 'home'
    itemFilter.value = '记录'
    respond(`「${item.title}」已经记下，但提醒没设成功。记录还在，你可以点铃铛重试。`)
  }

  function reset() {
    interrupt()
    clearTaskTimers()
    taskGeneration += 1
    Object.assign(data, initialData())
    view.value = 'home'; panel.value = ''; result.value = null; job.value = null
    reply.value = initialReply; lastUser.value = ''; temporary.value = false
    playing.value = false; musicStarted.value = false; position.value = 0; trackId.value = 'slow-tide'
    queue.value = tracks.map(track => track.id)
    focus.active = false; focus.remaining = 1500; focus.taskTitle = ''; seen.value = false; modal.value = null
    voiceOpen.value = false; voiceIssue.value = ''; selectedCandidateId.value = ''; excludedCandidateIds.value = []
    memoryFilter.value = '关于我'; itemFilter.value = '待办'; memoryTopicId.value = ''; historyTopicId.value = ''; activeTopicId.value = 'seamo-plan'
    Object.assign(editor, { title: '', body: '', id: '', input: '', generated: false, saved: false, previousBody: '', selection: '' })
    notify('已重置原型数据，真实应用的数据不受影响')
  }

  function keyDown(event) {
    if (event.key === 'Escape') {
      if (modal.value) closeModal()
      else if (voiceOpen.value) cancelVoice()
      else panel.value = ''
      if (pointerHolding) phase.value = 'idle'
      pointerHolding = false
      return
    }
    const target = event.target
    if (event.code !== 'Space' || event.repeat || event.metaKey || event.ctrlKey || event.altKey || modal.value || target instanceof HTMLElement && (target.matches('input,textarea,select,button') || target.isContentEditable)) return
    event.preventDefault()
    pointerHolding = true
    startVoice()
  }

  function keyUp(event) {
    if (event.code !== 'Space' || !pointerHolding) return
    event.preventDefault()
    pointerHolding = false
    phase.value = 'idle'
    if (!voiceDraft.value.trim()) voiceIssue.value = '原型未连接麦克风。输入一句话，即可继续模拟语音链路。'
  }

  function blur() { if (pointerHolding) { pointerHolding = false; phase.value = 'idle' } }
  window.addEventListener('keydown', keyDown)
  window.addEventListener('keyup', keyUp)
  window.addEventListener('blur', blur)

  const tick = window.setInterval(() => {
    const now = performance.now()
    const elapsed = Math.min(2, (now - lastTick) / 1000)
    lastTick = now
    if (playing.value) {
      position.value += elapsed
      if (position.value >= currentTrack.value.duration) {
        const next = queue.value[queue.value.indexOf(trackId.value) + 1]
        if (next) { position.value = 0; playTrack(next) }
        else { position.value = currentTrack.value.duration; playing.value = false }
      }
    }
    if (focus.active && !focus.paused) {
      focus.remaining = Math.max(0, focus.remaining - elapsed)
      if (focus.remaining === 0) { focus.active = false; notify('这一段专注结束了，休息一下吧。') }
    }
    const time = now / 1000
    const energy = playing.value && !data.reducedMotion ? 1 : 0
    bands.bass = energy * (0.2 + Math.pow((Math.sin(time * 2.2) + 1) / 2, 4) * 0.35)
    bands.mid = energy * (0.24 + Math.sin(time * 0.8) * 0.08)
    bands.treble = energy * (0.1 + Math.sin(time * 1.8) * 0.06)
    bands.beat = bands.bass * 0.5
    bands.flux = energy * 0.08
    audioLevel.value = data.reducedMotion ? 0 : phase.value === 'speaking' ? 0.14 + Math.abs(Math.sin(time * 3)) * 0.18 : bands.mid
  }, 100)

  onBeforeUnmount(() => {
    disposed = true
    clearInterval(tick); clearTimeout(toastTimer); interrupt(); clearTaskTimers()
    window.removeEventListener('keydown', keyDown)
    window.removeEventListener('keyup', keyUp)
    window.removeEventListener('blur', blur)
  })

  return {
    data, view, panel, input, reply, lastUser, phase, temporary, result, toast, modal, voiceDraft, voiceOpen, voiceIssue,
    memoryFilter, memoryTopicId, memoryQuery, filteredTopics, itemFilter, itemQuery, groupedItems, historyTopicId, historyGroups, activeTopicId, undoItem,
    job, searchQuery, nextSearchFails, selectedCandidateId, searchOptions,
    musicTab, musicQuery, musicSource, musicSearched, trackId, musicStarted, playing, position, queue,
    focus, editor, settings, bands, audioLevel, seen, currentTrack, particleState, statusLabel,
    filteredMemories, filteredItems, foundTracks, lyricIndex, outstandingCount,
    notify, openPanel, interrupt, respond, addMemory, continueTopic, saveCandidate, search, controlJob,
    playTrack, toggleMusic, skip, favorite, moveQueue, openItem, openReminder, saveReminder, saveItem, confirmItemSave, toggleItem, restoreItem,
    completeItem, deleteItem, confirmDelete, editMemory, saveMemory, toggleTemporary,
    startFocus, generateWork, reviseWork, undoWork, saveWork, copyWork, exportWork, saveSettings, startVoice, cancelVoice,
    closeModal, sendVoice, send, continueRemember, confirmRemember, confirmCandidateSave, previewDue, previewPartial, reset
  }
}
