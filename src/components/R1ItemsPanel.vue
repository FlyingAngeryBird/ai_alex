<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { Bell, Check, FileText, NotebookPen, Plus, Search, Timer, Trash2, X } from 'lucide-vue-next'
import R1ItemActionDialog from '@/components/R1ItemActionDialog.vue'
import type { Item, Reminder } from '../../electron/shared/r1Api'

const props = defineProps<{ temporaryMode: boolean }>()
const emit = defineEmits<{ close: []; startFocus: [] }>()
const items = ref<Item[]>([])
const reminders = ref<Reminder[]>([])
const query = ref('')
const tab = ref<'todo' | 'note'>('todo')
const busy = ref(false)
const loading = ref(false)
const message = ref('')
const editor = ref<{ item: Item | null; kind: 'todo' | 'note'; title: string; body: string } | null>(null)
const reminderEditor = ref<{ item: Item | null; reminder: Reminder | null; body: string; at: string } | null>(null)
const deletion = ref<{ item: Item; reminders: { reminderId: string; scheduleVersion: number; status: string }[] } | null>(null)
const deleteError = ref('')
const persistAcknowledged = ref(false)
let stopEvents: (() => void) | null = null
let stopItemChanges: (() => void) | null = null

const outstanding = computed(() => items.value.filter(item => item.kind === 'todo' && !item.completedAt).length)
const filtered = computed(() => items.value.filter(item => item.kind === tab.value &&
  `${item.title} ${item.body}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
const groups = computed(() => {
  if (tab.value === 'note') return [{ title: '最近留下的记录', entries: filtered.value }]
  const today = new Date().toDateString()
  const due = (item: Item) => reminders.value.find(reminder => reminder.itemId === item.itemId && reminder.status !== 'cancelled')
  return [
    { title: '今天', entries: filtered.value.filter(item => !item.completedAt && due(item) && new Date(due(item)!.dueAtUtc).toDateString() === today) },
    { title: '之后', entries: filtered.value.filter(item => !item.completedAt && due(item) && new Date(due(item)!.dueAtUtc).toDateString() !== today) },
    { title: '未定时间', entries: filtered.value.filter(item => !item.completedAt && !due(item)) },
    { title: '已完成', entries: filtered.value.filter(item => item.completedAt) }
  ].filter(group => group.entries.length)
})
const independentReminders = computed(() => reminders.value.filter(reminder => !reminder.itemId && reminder.status !== 'cancelled'))

function firstReminder(item: Item): Reminder | undefined {
  return reminders.value.find(reminder => reminder.itemId === item.itemId && reminder.status !== 'cancelled')
}
function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}
function localDateTime(value: string): string {
  const date = new Date(value)
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return shifted.toISOString().slice(0, 16)
}
function persistentAllowed(): boolean {
  if (!props.temporaryMode || persistAcknowledged.value) return true
  message.value = '请先确认：保存的事项或提醒会独立留在设备上，退出临时对话后仍保留。'
  return false
}
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message === 'VERSION_CONFLICT'
    ? '这件事已有新版本，请关闭编辑窗口并重新打开。' : fallback
}
async function refresh(): Promise<void> {
  loading.value = true
  try {
    const [itemResult, reminderResult] = await Promise.all([
      window.seamoR1.items.list(), window.seamoR1.reminders.list()
    ])
    if (!itemResult.ok || !reminderResult.ok) throw new Error('READ_FAILED')
    items.value = itemResult.data
    reminders.value = reminderResult.data
  } catch { message.value = '事项暂时无法读取，请重试。' }
  finally { loading.value = false }
}
function openItem(item: Item | null = null): void {
  message.value = ''
  editor.value = { item, kind: item?.kind ?? tab.value, title: item?.title ?? '', body: item?.body ?? '' }
}
async function saveItem(): Promise<void> {
  const draft = editor.value
  if (!draft || busy.value || !draft.title.trim() || !persistentAllowed()) return
  busy.value = true
  message.value = ''
  try {
    const result = draft.item
      ? await window.seamoR1.items.update({ actionId: crypto.randomUUID(), itemId: draft.item.itemId,
          expectedVersion: draft.item.version, kind: draft.kind, title: draft.title, body: draft.body })
      : await window.seamoR1.items.create({ actionId: crypto.randomUUID(), kind: draft.kind,
          title: draft.title, body: draft.body })
    if (!result.ok) throw new Error(result.error.code)
    editor.value = null
    tab.value = draft.kind
    await refresh()
    message.value = draft.item ? '事项已更新。' : '事项已保存。'
  } catch (error) { message.value = errorMessage(error, '保存失败，请检查内容后重试。') }
  finally { busy.value = false }
}
async function toggle(item: Item): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const result = await window.seamoR1.items.complete({ actionId: crypto.randomUUID(), itemId: item.itemId,
      expectedVersion: item.version, completed: !item.completedAt })
    if (!result.ok) throw new Error(result.error.code)
    await refresh()
    message.value = item.completedAt ? '已恢复待办。' : '待办已完成；未投递的专用催办提醒已按规则处理。'
  } catch (error) { message.value = errorMessage(error, '更新失败，请刷新后重试。') }
  finally { busy.value = false }
}
async function exportItem(format: 'txt' | 'md'): Promise<void> {
  const draft = editor.value, item = draft?.item
  if (!draft || !item || busy.value) return
  if (draft.title !== item.title || draft.body !== item.body || draft.kind !== item.kind) {
    message.value = '请先保存修改，再导出这个版本。'; return
  }
  busy.value = true; message.value = ''
  try {
    const result = await window.seamoR1.items.export({ items: [{ itemId: item.itemId, expectedVersion: item.version }], format })
    if (!result.ok) throw new Error(result.error.code)
    message.value = result.data.cancelled ? '已取消导出，事项保留。' : `已导出事项版本 ${item.version}。`
  } catch (error) { message.value = error instanceof Error && error.message === 'EXPORT_FILE_WRITTEN_RECEIPT_FAILED'
    ? '文件已写出，但导出回执未能保存。请检查所选位置，不要重复导出。'
    : errorMessage(error, '导出未完成，请检查当前版本和保存位置后重试。') }
  finally { busy.value = false }
}
function openReminder(item: Item | null = null): void {
  const reminder = item ? firstReminder(item) ?? null : null
  message.value = ''
  reminderEditor.value = { item, reminder, body: reminder?.body ?? item?.title ?? '',
    at: reminder ? localDateTime(reminder.dueAtUtc) : '' }
}
function openExistingReminder(reminder: Reminder): void {
  reminderEditor.value = { item: null, reminder, body: reminder.body,
    at: localDateTime(reminder.dueAtUtc) }
}
async function saveReminder(): Promise<void> {
  const draft = reminderEditor.value
  if (!draft || busy.value || !draft.body.trim() || !persistentAllowed()) return
  const date = new Date(draft.at)
  if (!draft.at || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    message.value = '请选择未来的具体日期和时间。'; return
  }
  busy.value = true
  try {
    const result = draft.reminder
      ? await window.seamoR1.reminders.reschedule({ actionId: crypto.randomUUID(),
          reminderId: draft.reminder.reminderId, expectedScheduleVersion: draft.reminder.scheduleVersion,
          dueAtUtc: date.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
      : await window.seamoR1.reminders.create({ actionId: crypto.randomUUID(),
          itemId: draft.item?.itemId, linkPurpose: draft.item?.kind === 'todo' ? 'todo_due' : 'independent',
          body: draft.body, dueAtUtc: date.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          kind: 'standard' })
    if (!result.ok) throw new Error(result.error.code)
    reminderEditor.value = null
    await refresh()
    message.value = `提醒已设置为 ${dateLabel(date.toISOString())}；应用运行且 Mac 清醒时调度。`
  } catch (error) { message.value = errorMessage(error, '提醒未保存，请重试；已有事项不会被删除。') }
  finally { busy.value = false }
}
async function cancelReminder(reminder: Reminder): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const result = await window.seamoR1.reminders.cancel({ actionId: crypto.randomUUID(),
      reminderId: reminder.reminderId, expectedScheduleVersion: reminder.scheduleVersion })
    if (!result.ok) throw new Error(result.error.code)
    reminderEditor.value = null
    await refresh()
    message.value = result.data.receipt.detail === 'cancelled_after_delivery_not_retracted'
      ? '后续调度已取消；已请求的系统通知无法撤回。' : '提醒已取消。'
  } catch (error) { message.value = errorMessage(error, '取消失败，请刷新后重试。') }
  finally { busy.value = false }
}
async function previewDeletion(item: Item): Promise<void> {
  const result = await window.seamoR1.items.deletionPreview(item.itemId)
  if (result.ok) { deletion.value = result.data; deleteError.value = '' }
  else message.value = '关联提醒已变化，请刷新后重试。'
}
async function deleteItem(disposition: 'keep' | 'cancel'): Promise<void> {
  if (!deletion.value || busy.value) return
  busy.value = true
  try {
    const preview = deletion.value
    const result = await window.seamoR1.items.delete({ actionId: crypto.randomUUID(),
      itemId: preview.item.itemId, expectedVersion: preview.item.version,
      reminderDisposition: disposition, confirmedReminders: preview.reminders })
    if (!result.ok) throw new Error(result.error.code)
    deletion.value = null
    await refresh()
    message.value = disposition === 'keep' ? '事项已删除，关联提醒按确认保留。' : '事项和未到期的关联提醒已取消。'
  } catch (error) { deleteError.value = errorMessage(error, '删除失败，请重新确认。') }
  finally { busy.value = false }
}
onMounted(() => {
  void refresh()
  stopEvents = window.seamoR1.reminders.onDue(() => { void refresh() })
  stopItemChanges = window.seamoR1.items.onChanged(() => { void refresh() })
})
onUnmounted(() => { stopEvents?.(); stopItemChanges?.() })
</script>

<template>
  <aside class="r1-basic-side r1-items-panel" aria-label="事项" @keydown.stop @keyup.stop>
    <header><div><small>SEAMO / YOUR THINGS</small><h2>事项</h2></div>
      <button type="button" aria-label="关闭侧栏" @click="emit('close')"><X :size="19" /></button></header>
    <div class="r1-basic-content">
      <div class="r1-items-summary"><span>{{ outstanding }} 件待办</span>
        <button type="button" @click="openItem()"><Plus :size="14" />新建</button></div>
      <label v-if="temporaryMode" class="r1-items-temporary"><input v-model="persistAcknowledged" type="checkbox" />
        我确认：在这里保存的事项和提醒会留在设备上，退出临时对话后仍保留。</label>
      <label class="r1-items-search"><Search :size="15" />
        <input v-model="query" placeholder="找一件事" aria-label="搜索事项" /></label>
      <div class="r1-items-tabs" role="tablist" aria-label="事项分类">
        <button type="button" role="tab" :aria-selected="tab === 'todo'" @click="tab = 'todo'">待办</button>
        <button type="button" role="tab" :aria-selected="tab === 'note'" @click="tab = 'note'">记录</button>
      </div>
      <p v-if="loading">正在读取事项…</p>
      <p v-if="message" class="r1-items-message" role="status">{{ message }}</p>
      <template v-if="!loading">
        <details v-for="group in groups" :key="group.title" class="r1-items-group" :open="group.title !== '已完成'">
          <summary>{{ group.title }} <small v-if="group.title === '已完成'">{{ group.entries.length }}</small></summary>
          <article v-for="item in group.entries" :key="item.itemId" class="r1-items-row" :class="{ completed: item.completedAt }">
            <button v-if="item.kind === 'todo'" type="button" role="checkbox" class="r1-items-check"
              :aria-checked="!!item.completedAt" :aria-label="`${item.completedAt ? '恢复' : '完成'}${item.title}`"
              :disabled="busy" @click="toggle(item)"><Check v-if="item.completedAt" :size="12" /></button>
            <FileText v-else :size="18" class="r1-items-note" />
            <button type="button" class="r1-items-content" @click="openItem(item)"><strong>{{ item.title }}</strong>
              <p v-if="item.body">{{ item.body }}</p><small v-if="firstReminder(item)" class="r1-items-due"><Bell :size="12" />{{ dateLabel(firstReminder(item)!.dueAtUtc) }}</small>
              <small v-else>{{ item.kind === 'todo' ? '待办' : '记录' }}</small></button>
            <button type="button" class="r1-items-icon" :aria-label="`设置或修改${item.title}的提醒`" @click="openReminder(item)"><Bell :size="14" /></button>
            <button type="button" class="r1-items-icon" :aria-label="`删除${item.title}`" @click="previewDeletion(item)"><Trash2 :size="14" /></button>
          </article>
        </details>
        <div v-if="!filtered.length" class="r1-items-empty"><NotebookPen :size="27" /><p>{{ query ? '没有找到这件事' : '这里暂时没有事项' }}</p>
          <button v-if="!query" type="button" @click="openItem()"><Plus :size="14" />记下一件事</button></div>
        <section v-if="independentReminders.length" class="r1-items-independent"><h3>独立提醒</h3>
          <article v-for="reminder in independentReminders" :key="reminder.reminderId"><p>{{ reminder.body }}</p>
            <small>{{ dateLabel(reminder.dueAtUtc) }} · {{ reminder.status === 'missed' ? '已错过，未发送过期通知' : reminder.status === 'due' ? '已到期，不代表已读' : '等待到期' }}</small><button type="button" @click="openExistingReminder(reminder)">改期</button>
            <button type="button" @click="cancelReminder(reminder)">取消</button></article></section>
        <button class="r1-items-add-reminder" type="button" @click="openReminder()"><Bell :size="14" />设置独立提醒</button>
        <button class="r1-items-add-reminder" type="button" @click="emit('startFocus')"><Timer :size="14" />开始一段专注</button>
        <p class="r1-items-scope">提醒在应用运行且 Mac 清醒时调度。休眠、关机或完全退出时无法保证准点。</p>
      </template>
    </div>
  </aside>

  <div v-if="editor" class="r1-memory-modal-backdrop" role="presentation" @click.self="editor = null">
    <form class="r1-memory-modal r1-items-modal" role="dialog" aria-modal="true" aria-label="编辑事项" @submit.prevent="saveItem">
      <small>YOUR THINGS</small><h3>{{ editor.item ? '把这件事理清楚' : '记下一件事' }}</h3>
      <label>事情<input v-model="editor.title" maxlength="80" required /></label>
      <label>补充内容<textarea v-model="editor.body" maxlength="8000" rows="4" /></label>
      <label>类型<select v-model="editor.kind"><option value="todo">待办</option><option value="note">记录</option></select></label>
      <p v-if="temporaryMode">保存后会独立留在设备上；请先在事项侧栏确认保存范围。</p>
      <div class="r1-memory-dialog-actions"><button type="button" @click="editor = null">取消</button>
        <button v-if="editor.item" type="button" :disabled="busy" @click="exportItem('txt')">导出 TXT</button>
        <button v-if="editor.item" type="button" :disabled="busy" @click="exportItem('md')">导出 Markdown</button>
        <button v-if="editor.item?.kind === 'todo'" type="button" @click="editor = null; emit('startFocus')">开始专注</button>
        <button type="submit" :disabled="busy || !editor.title.trim()">保存</button></div>
      <p v-if="message" role="status">{{ message }}</p>
    </form>
  </div>
  <div v-if="reminderEditor" class="r1-memory-modal-backdrop" role="presentation" @click.self="reminderEditor = null">
    <form class="r1-memory-modal r1-items-modal" role="dialog" aria-modal="true" aria-label="设置提醒" @submit.prevent="saveReminder">
      <small>YOUR THINGS</small><h3>{{ reminderEditor.reminder ? '修改提醒' : '设置一次性提醒' }}</h3>
      <label>提醒内容<input v-model="reminderEditor.body" maxlength="8000" required :disabled="!!reminderEditor.reminder" /></label>
      <label>具体日期和时间<input v-model="reminderEditor.at" type="datetime-local" required /></label>
      <p>只在应用运行且 Mac 清醒时调度；完全退出、关机或休眠期间不保证准点。</p>
      <div class="r1-memory-dialog-actions"><button v-if="reminderEditor.reminder" type="button" :disabled="busy" @click="cancelReminder(reminderEditor.reminder)">取消提醒</button>
        <button type="button" @click="reminderEditor = null">返回</button><button type="submit" :disabled="busy">保存时间</button></div>
      <p v-if="message" role="status">{{ message }}</p>
    </form>
  </div>
  <R1ItemActionDialog v-if="deletion" action="confirm_item_delete" :item-title="deletion.item.title"
    :reminders="deletion.reminders" :busy="busy" :error="deleteError" @close="deletion = null"
    @keep="deleteItem('keep')" @cancel-reminders="deleteItem('cancel')" />
</template>

<style scoped>
.r1-items-summary{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;color:#89978f;font-size:11px}
.r1-items-summary button,.r1-items-empty button,.r1-items-add-reminder{display:inline-flex;align-items:center;gap:6px;border:0;background:none;color:var(--r1-aqua);font-size:11px}
.r1-items-search{display:flex;align-items:center;gap:9px;height:43px;padding:0 12px;border:1px solid var(--r1-line);border-radius:6px;background:#ffffff06;color:#788a83}
.r1-items-search input{flex:1;min-width:0;height:100%;border:0;outline:0;background:none;color:var(--r1-text);font-size:12px}
.r1-items-tabs{display:flex;gap:22px;margin:17px 0 8px;border-bottom:1px solid var(--r1-line)}
.r1-items-tabs button{min-height:42px;padding:0 0 4px;border:0;border-bottom:2px solid transparent;background:none;color:#7f8b84;font-size:12px}
.r1-items-tabs button[aria-selected=true]{border-bottom-color:var(--r1-aqua);color:#e5e9dc}
.r1-items-group{margin-top:16px}.r1-items-group>summary{color:#8d9d93;font-size:11px;cursor:pointer}.r1-items-group>summary small{margin-left:5px}
.r1-items-row{display:flex;align-items:flex-start;gap:11px;padding:16px 0;border-bottom:1px solid var(--r1-line)!important}
.r1-items-check{display:grid;place-items:center;flex:none;width:17px;height:17px;margin-top:5px;padding:0;border:1px solid #596c62;border-radius:4px;background:none;color:#172c24}
.r1-items-check[aria-checked=true]{border-color:var(--r1-aqua);background:var(--r1-aqua)}
.r1-items-note{flex:none;margin-top:4px;color:#a29b81}
.r1-items-content{flex:1;min-width:0;padding:0;border:0;background:none;text-align:left}
.r1-items-content strong{display:block;color:#d9dcd2;font-size:13px;font-weight:400;line-height:1.7;overflow-wrap:anywhere}
.r1-items-content p{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin:5px 0 8px;color:#7e8b83;font-size:11px;line-height:1.7;overflow-wrap:anywhere}
.r1-items-content small{color:#74837b;font-size:10px}.r1-items-due{display:flex;align-items:center;gap:5px;color:#c4b889!important}
.r1-items-row.completed .r1-items-content strong{text-decoration:line-through;color:#6e7e73}
.r1-items-icon{flex:none;display:grid;place-items:center;width:22px;height:25px;padding:0;border:0;background:none;color:#788d82}.r1-items-icon:hover{color:var(--r1-aqua)}
.r1-items-empty{display:flex;flex-direction:column;align-items:center;gap:14px;padding:58px 8px;color:#75877d;text-align:center}.r1-items-empty p{margin:0;font-size:12px}
.r1-items-independent{margin-top:24px;border-top:1px solid var(--r1-line)}.r1-items-independent h3{font-size:12px;font-weight:400;color:#b3bba9}
.r1-items-independent article{display:flex;align-items:center;flex-wrap:wrap;gap:7px}.r1-items-independent article p{flex-basis:100%;margin:0}.r1-items-independent article small{margin-right:auto}
.r1-items-independent article button{border:0;background:none;color:var(--r1-aqua);font-size:11px}
.r1-items-add-reminder{margin-top:23px}.r1-items-scope{margin:13px 0 30px!important;color:#697b72!important;font-size:10px!important}.r1-items-message{padding:8px 0;color:#d0b789!important}
.r1-items-temporary{display:flex;align-items:flex-start;gap:8px;margin-bottom:16px;color:#c8b68c;font-size:11px;line-height:1.6}.r1-items-temporary input{flex:none;margin-top:3px}
.r1-items-modal small{color:#80968a;font-size:9px;letter-spacing:.1em}.r1-items-modal input{box-sizing:border-box;width:100%;padding:9px;border:1px solid #35413d;border-radius:5px;background:#111718;color:#eff1e9;font:inherit;font-size:12px}.r1-items-modal .r1-memory-dialog-actions{flex-wrap:wrap}
</style>
