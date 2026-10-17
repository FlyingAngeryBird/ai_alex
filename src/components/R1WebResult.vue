<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, ChevronRight, Globe, Columns2, Bookmark, Bell } from 'lucide-vue-next'
import type { R1Task, WebCandidate } from '../../electron/main/r1/taskSupervisor'
import type { WebSource } from '../../electron/main/providers/pageReader'
const props = defineProps<{ task: R1Task }>()
const compare = ref(false), selectedId = ref<string | null>(null), selectedSource = ref<string | null>(null)
const error = ref(''), notice = ref(''), busy = ref(false), draftTitle = ref('')
const confirmTemporary = ref(false)
const savedItems = ref<Record<string, { itemId: string; title: string; version: number }>>({})
const reminderAt = ref(''), reminderBody = ref(''), reminderOpen = ref(false)
let reminderActionId = crypto.randomUUID()
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
async function choose(candidate: WebCandidate): Promise<void> {
  if (busy.value) return
  const scope = `${props.task.taskId}:${props.task.goalVersion}`
  busy.value = true; error.value = ''
  try {
    const result = await window.seamoR1.tasks.selectCandidate({ taskId: props.task.taskId,
      expectedGoalVersion: props.task.goalVersion, candidateId: candidate.candidateId })
    if (`${props.task.taskId}:${props.task.goalVersion}` !== scope) return
    if (!result.ok) throw new Error(result.error.code)
    selectedId.value = candidate.candidateId; draftTitle.value = candidate.label
    confirmTemporary.value = false; reminderOpen.value = false; notice.value = ''
  } catch { if (`${props.task.taskId}:${props.task.goalVersion}` === scope) error.value = '候选已变化，请刷新后重新选择。' }
  finally { busy.value = false }
}
async function saveSelected(): Promise<void> {
  const id = selectedId.value
  if (!id || busy.value) return
  if (!draftTitle.value.trim() || [...draftTitle.value].length > 80) { error.value = '请填写不超过 80 个字符的记录标题。'; return }
  if (props.task.temporary && !confirmTemporary.value) { confirmTemporary.value = true; return }
  const scope = `${props.task.taskId}:${props.task.goalVersion}`
  busy.value = true; error.value = ''
  try {
    const result = await window.seamoR1.tasks.saveCandidate({ taskId: props.task.taskId,
      expectedGoalVersion: props.task.goalVersion, candidateId: id, title: draftTitle.value,
      temporarySaveConfirmed: confirmTemporary.value })
    if (`${props.task.taskId}:${props.task.goalVersion}` !== scope) return
    if (!result.ok) throw new Error(result.error.code)
    savedItems.value[id] = result.data; confirmTemporary.value = false
    notice.value = '已记下，来源与读取范围一并保留。'
  } catch { if (`${props.task.taskId}:${props.task.goalVersion}` === scope) error.value = '记录未保存，请检查当前结果后重试。' }
  finally { busy.value = false }
}
async function saveReminder(): Promise<void> {
  const item = selectedId.value ? savedItems.value[selectedId.value] : null
  if (!item || busy.value) return
  const date = new Date(reminderAt.value)
  if (!reminderAt.value || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now() || !reminderBody.value.trim()) {
    error.value = '请填写提醒事项和未来的具体日期、时间。'; return
  }
  const local = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}T${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
  if (local !== reminderAt.value) { error.value = '该时区中这个时间不存在，请选择一个有效时间。'; return }
  const scope = `${props.task.taskId}:${props.task.goalVersion}`
  busy.value = true; error.value = ''
  try {
    const result = await window.seamoR1.reminders.create({ actionId: reminderActionId, itemId: item.itemId,
      linkPurpose: 'independent', body: reminderBody.value, dueAtUtc: date.toISOString(), timezone, kind: 'standard' })
    if (`${props.task.taskId}:${props.task.goalVersion}` !== scope) return
    if (!result.ok) throw new Error(result.error.code)
    notice.value = `提醒已安排在 ${date.toLocaleString('zh-CN', { timeZone: timezone })}（${timezone}），Mac 清醒且应用运行时调度。`
    reminderOpen.value = false
  } catch { if (`${props.task.taskId}:${props.task.goalVersion}` === scope) error.value = '提醒未安排，已经保存的记录仍保留；可重试提醒。' }
  finally { busy.value = false }
}
function editReminder(): void {
  reminderOpen.value = true; reminderBody.value = savedItems.value[selectedId.value!].title
  reminderAt.value = ''; reminderActionId = crypto.randomUUID(); error.value = ''
}
watch([reminderAt, reminderBody], () => { if (!busy.value) reminderActionId = crypto.randomUUID() })
const candidates = computed(() => props.task.webResult?.candidates ?? [])
const sources = computed(() => props.task.webResult?.sources ?? [])
const sourceDetail = computed(() => sources.value.find(source => source.sourceRef === selectedSource.value))
watch(() => `${props.task.taskId}:${props.task.goalVersion}`, () => {
  selectedId.value = null; selectedSource.value = null; compare.value = false; error.value = ''; confirmTemporary.value = false; reminderOpen.value = false; notice.value = ''
})
const candidateSources = (candidate: WebCandidate) => sources.value.filter(source => candidate.sourceRefs.includes(source.sourceRef))
function summary(candidate: WebCandidate): string {
  return candidateSources(candidate)[0]?.snippet || candidate.fields.find(field => field.value)?.value || '当前来源没有可显示的摘要。'
}
function readLabel(source: WebSource): string {
  return source.readStatus === 'read' ? '已读取页面' : source.readStatus === 'partial' ? '读取了部分页面' : source.readStatus === 'failed' ? '页面读取失败' : '仅搜索摘要 · 页面尚未读取'
}
async function openSource(source: WebSource): Promise<void> {
  error.value = ''
  const taskId = props.task.taskId
  try {
    const result = await window.seamoR1.tasks.openSource({ taskId, sourceRef: source.sourceRef })
    if (taskId === props.task.taskId && !result.ok) error.value = result.error.message
  } catch { if (taskId === props.task.taskId) error.value = '来源暂时无法打开，请重试。' }
}
</script>
<template>
  <section v-if="candidates.length || sources.length" class="web-results" aria-label="联网查询结果">
    <div class="result-heading"><h3>找到的方向</h3><button v-if="candidates.length > 1" type="button" :aria-pressed="compare" @click="compare = !compare"><Columns2 :size="14" />{{ compare ? '返回列表' : '比较一下' }}</button></div>
    <div :class="{ 'compare-grid': compare }">
      <article v-for="(candidate, index) in candidates" :key="candidate.candidateId" class="candidate-row" :class="{ selected: selectedId === candidate.candidateId }">
        <span v-if="!compare" class="candidate-number">{{ String(index + 1).padStart(2, '0') }}</span>
        <div class="candidate-main"><button class="candidate-title" type="button" :disabled="busy" @click="choose(candidate)">{{ candidate.label }}<Check v-if="selectedId === candidate.candidateId" :size="16" /></button>
          <p>{{ summary(candidate) }}</p>
          <p class="candidate-caveat">{{ candidateSources(candidate).map(readLabel).join(' / ') || '来源信息待补齐' }}</p>
          <div class="source-links"><button v-for="source in candidateSources(candidate)" :key="source.sourceRef" type="button" @click="selectedSource = source.sourceRef"><Globe :size="12" />查看来源<ChevronRight :size="12" /></button></div>
          <button class="selection-button" type="button" :aria-pressed="selectedId === candidate.candidateId" :disabled="busy" @click="choose(candidate)">{{ selectedId === candidate.candidateId ? '已选中' : '选这个' }}</button>
        </div>
      </article>
    </div>
    <div v-if="selectedId" class="candidate-save">
      <label>记录标题<input v-model="draftTitle" aria-label="候选记录标题" :disabled="busy" maxlength="80" /></label>
      <div class="source-links"><button type="button" :disabled="busy" @click="saveSelected"><Bookmark :size="13" />{{ savedItems[selectedId] ? '已记下' : '记下来' }}</button>
        <button v-if="savedItems[selectedId]" type="button" :disabled="busy" @click="editReminder"><Bell :size="13" />加个提醒</button></div>
      <div v-if="confirmTemporary" class="temporary-confirm"><p>保存这条记录及来源，结束临时对话后仍会保留。</p><button :disabled="busy" type="button" @click="saveSelected">确认保存</button><button type="button" @click="confirmTemporary = false">取消</button></div>
      <form v-if="reminderOpen" @submit.prevent="saveReminder">
        <label>提醒事项<input v-model="reminderBody" aria-label="候选提醒事项" :disabled="busy" maxlength="8000" required /></label>
        <label>具体日期和时间<input v-model="reminderAt" aria-label="候选提醒时间" type="datetime-local" :disabled="busy" required /></label>
        <p>时区：{{ timezone }}。提醒与记录分别保存。</p>
        <button type="submit" :disabled="busy">确认安排提醒</button><button type="button" :disabled="busy" @click="reminderOpen = false">取消</button>
      </form>
    </div>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="!candidates.length" class="source-links"><button v-for="source in sources" :key="source.sourceRef" type="button" @click="selectedSource = source.sourceRef">{{ source.title }}</button></div>
    <aside v-if="sourceDetail" class="source-detail" aria-label="来源信息">
      <div class="result-heading"><strong>{{ sourceDetail.title }}</strong><button type="button" @click="selectedSource = null">收起来源</button></div>
      <dl><dt>读取范围</dt><dd>{{ readLabel(sourceDetail) }}</dd><dt>页面日期</dt><dd>{{ sourceDetail.publishedAt || '页面未提供可确认日期' }}</dd><dt>访问时间</dt><dd>{{ sourceDetail.accessedAt }}</dd></dl>
      <p>{{ sourceDetail.snippet }}</p><button type="button" @click="openSource(sourceDetail)"><Globe :size="13" />打开原始页面</button>
    </aside>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.web-results{padding:20px 0}.result-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.result-heading h3{margin:0;font-size:16px;font-weight:500;color:var(--r1-text)}button{display:inline-flex;align-items:center;gap:6px;border:0;background:none;color:var(--r1-aqua);font-size:11px;cursor:pointer}.candidate-row{display:flex;gap:16px;padding:22px 0;border-bottom:1px solid var(--r1-line)}.candidate-number{font-size:11px;color:var(--r1-muted);padding-top:6px}.candidate-main{min-width:0;flex:1}.candidate-title{font-size:17px;text-align:left;color:var(--r1-text)}p{font-size:12px;line-height:1.85;color:#b1bcb7;white-space:pre-wrap;overflow-wrap:anywhere}.candidate-caveat{color:#8a9690;font-size:11px}.source-links{display:flex;gap:12px;flex-wrap:wrap}.selection-button{margin-top:14px}.compare-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.compare-grid .candidate-row{border:1px solid var(--r1-line);border-radius:8px;padding:18px}.source-detail{border:1px solid var(--r1-line);border-radius:8px;padding:18px;margin-top:20px;background:#11171b}.source-detail strong{font-size:14px;font-weight:500}.source-detail dl{display:grid;grid-template-columns:70px 1fr;gap:8px;font-size:11px}.source-detail dt{color:var(--r1-muted)}.source-detail dd{margin:0;color:#b1bcb7;overflow-wrap:anywhere}
@media(max-width:760px){.compare-grid{grid-template-columns:1fr}}
</style>

<style scoped>
.candidate-save{padding:18px 0;border-bottom:1px solid var(--r1-line)}.candidate-save label{display:block;font-size:11px;color:var(--r1-muted);margin-bottom:12px}.candidate-save input{display:block;width:100%;border:1px solid var(--r1-line);border-radius:6px;padding:10px;margin-top:7px;background:#171d20;color:var(--r1-text)}.candidate-save form,.temporary-confirm{margin-top:18px}.candidate-save button:disabled{opacity:.45;cursor:default}
</style>
