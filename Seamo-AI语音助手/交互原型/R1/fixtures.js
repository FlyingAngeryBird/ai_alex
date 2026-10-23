export const tracks = [
  {
    id: 'slow-tide', title: '缓慢的潮汐', artist: 'Seamo Sessions', album: '留一点时间给自己',
    source: 'netease', duration: 208,
    art: 'https://images.unsplash.com/photo-1518837695005-2083093ee35b?auto=format&fit=crop&w=400&q=80',
    note: '这一段留给海风。今天，不必着急。',
    lyrics: ['把喧嚣留在远处', '让晚风慢一点经过', '那些还没有答案的事', '此刻可以先放下', '听见时间轻轻流动', '也听见自己的呼吸', '不必急着走向明天', '这一刻，就很好']
  },
  {
    id: 'forest', title: '林间来信', artist: 'Seamo Sessions', album: '在安静的地方',
    source: 'kuwo', duration: 182,
    art: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?auto=format&fit=crop&w=400&q=80',
    note: '没有歌词，留一些空间给正在做的事。', lyrics: []
  },
  {
    id: 'afternoon', title: '午后，无事', artist: 'Seamo Sessions', album: '在安静的地方',
    source: 'joox', duration: 196,
    art: 'https://images.unsplash.com/photo-1473448912268-2022ce9509d8?auto=format&fit=crop&w=400&q=80',
    note: '一首很轻的练习曲。陪你把今天慢慢过完。',
    lyrics: ['把窗留给日光', '把今天交给远方', '风从树影里经过', '有些话不必说完', '慢慢地，慢慢地', '找到自己的方向']
  }
]

export const seedMemories = [
  { id: 'm1', text: '工作时偏爱没有歌词、节奏平缓的音乐。', category: '偏好', source: '你说：做方案时，有歌词容易分心。', updated: '昨天', enabled: true },
  { id: 'm2', text: '正在准备个人 AI 助手的产品方案。', category: '近况', source: '你说：最近在整理 Seamo 的产品方案。', updated: '昨天', enabled: true },
  { id: 'm3', text: '先把核心功能链路跑通，再调整整体布局。', category: '共同结论', source: '产品讨论中，你明确确认的下一步。', updated: '今天', enabled: true }
]

export const seedTopics = [
  {
    id: 'seamo-plan', title: '个人 AI 助手的产品方案', updated: '今天',
    current: '先把核心功能链路跑通，再调整整体布局。',
    events: [
      { id: 't1', when: '昨天', text: '开始整理助手的产品方案。' },
      { id: 't2', when: '今天', text: '确认先验证功能链路，再调整整体布局。' }
    ]
  }
]

export const seedItems = [
  { id: 'i1', title: '梳理 Seamo 的核心使用场景', body: '先验证自然聊天、跨天接续，以及边听歌边办一件小事。', kind: '待办', done: false, reminder: '', created: '今天' },
  { id: 'i2', title: '关于陪伴的一点想法', body: '不用每次都给建议。有时候，接住一句话，然后一起安静一会儿，就足够了。', kind: '记录', done: false, reminder: '', created: '昨天' }
]

export const searchCandidates = [
  { id: 'place1', title: '湖边的慢行半日', meta: '户外散步 · 约 2 小时', text: '符合你想安静走走、行程不排满的条件。先走一段临水步道，再找地方坐坐。', caveat: '需确认天气和往返交通。', source: '虚构行程候选，非实时查询结果', url: '' },
  { id: 'place2', title: '运河边的一场小展', meta: '室内看展 · 约 90 分钟', text: '室内行程更稳妥，看展后仍能沿河稍坐，随时可以结束。', caveat: '展览时间和门票尚未核实。', source: '虚构展览候选，非实时活动信息', url: '' }
]

export const initialReply = '我在。今天想从哪件事聊起？'

export function formatTime(seconds) {
  const value = Math.max(0, Math.floor(seconds))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}

export function tomorrowAt(hour = 20, minute = 0) {
  const day = new Date()
  day.setDate(day.getDate() + 1)
  day.setHours(hour, minute, 0, 0)
  const local = new Date(day.getTime() - day.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

export function displayDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
