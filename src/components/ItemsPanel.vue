<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { Item, Reminder } from '../../electron/shared/r1Api'

const emit = defineEmits<{ close: [] }>()
const items = ref<Item[]>([])
const reminders = ref<Reminder[]>([])
const kind = ref<'note' | 'todo'>('note')
const title = ref('')
const body = ref('')
const reminderBody = ref('')
const reminderTime = ref('')
const reminderItemId = ref('')
const reminderPurpose = ref<'todo_due' | 'independent'>('independent')
const editingReminderId = ref('')
const editedReminderTime = ref('')
const busy = ref(false)
const error = ref('')
const pendingDeletion = ref<{
  item: Item
  reminders: { reminderId: string; scheduleVersion: number; status: string }[]
} | null>(null)

async function refresh(): Promise<void> {
  if (!window.seamoR1) {
    error.value = '事项服务不可用，请从桌面应用重新打开。'
    return
  }
  const [itemResult, reminderResult] = await Promise.all([
    window.seamoR1.items.list(), window.seamoR1.reminders.list()
  ])
  if (!itemResult.ok || !reminderResult.ok) {
    error.value = '读取事项失败，请重试。'
    return
  }
  items.value = itemResult.data
  reminders.value = reminderResult.data
  error.value = ''
}

async function createItem(): Promise<void> {
  if (!title.value.trim() || !body.value.trim() || busy.value) return
  busy.value = true
  try {
    const result = await window.seamoR1.items.create({ actionId: crypto.randomUUID(),
      kind: kind.value, title: title.value, body: body.value })
    if (!result.ok) throw new Error(result.error.message)
    title.value = ''
    body.value = ''
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败，请重试。'
  } finally { busy.value = false }
}

async function createReminder(): Promise<void> {
  if (!reminderBody.value.trim() || !reminderTime.value || busy.value) return
  const due = new Date(reminderTime.value)
  if (!Number.isFinite(due.getTime()) || due.getTime() <= Date.now()) {
    error.value = '请选择未来的具体日期和时间。'
    return
  }
  busy.value = true
  try {
    const result = await window.seamoR1.reminders.create({ actionId: crypto.randomUUID(),
      itemId: reminderItemId.value || undefined,
      linkPurpose: reminderItemId.value ? reminderPurpose.value : 'independent',
      body: reminderBody.value, dueAtUtc: due.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, kind: 'standard' })
    if (!result.ok) throw new Error(result.error.message)
    reminderBody.value = ''
    reminderTime.value = ''
    reminderItemId.value = ''
    reminderPurpose.value = 'independent'
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '提醒保存失败；事项仍保留，可以单独重试。'
  } finally { busy.value = false }
}

async function rescheduleReminder(reminder: Reminder): Promise<void> {
  const date = new Date(editedReminderTime.value)
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    error.value = '请选择未来的具体日期和时间。'
    return
  }
  busy.value = true
  try {
    const result = await window.seamoR1.reminders.reschedule({ actionId: crypto.randomUUID(),
      reminderId: reminder.reminderId, expectedScheduleVersion: reminder.scheduleVersion,
      dueAtUtc: date.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
    if (!result.ok) throw new Error(result.error.message)
    editingReminderId.value = ''
    editedReminderTime.value = ''
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '改期失败，请刷新后重试。'
  } finally { busy.value = false }
}

async function cancelReminder(reminder: Reminder): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const result = await window.seamoR1.reminders.cancel({ actionId: crypto.randomUUID(),
      reminderId: reminder.reminderId, expectedScheduleVersion: reminder.scheduleVersion })
    if (!result.ok) throw new Error(result.error.message)
    await refresh()
    if (result.data.receipt.detail === 'cancelled_after_delivery_not_retracted') {
      error.value = '已取消后续调度；已经请求的系统通知无法撤回。'
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '取消失败，请刷新后重试。'
  } finally { busy.value = false }
}

async function toggleTodo(item: Item): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const result = await window.seamoR1.items.complete({ actionId: crypto.randomUUID(),
      itemId: item.itemId, expectedVersion: item.version, completed: !item.completedAt })
    if (!result.ok) throw new Error(result.error.message)
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '更新失败，请刷新后重试。'
  } finally { busy.value = false }
}

async function previewDeletion(item: Item): Promise<void> {
  const result = await window.seamoR1.items.deletionPreview(item.itemId)
  if (!result.ok) {
    error.value = '关联提醒已变化，请刷新后重试。'
    return
  }
  pendingDeletion.value = result.data
}

async function deleteItem(disposition: 'keep' | 'cancel'): Promise<void> {
  const preview = pendingDeletion.value
  if (!preview || busy.value) return
  busy.value = true
  try {
    const result = await window.seamoR1.items.delete({ actionId: crypto.randomUUID(),
      itemId: preview.item.itemId, expectedVersion: preview.item.version,
      reminderDisposition: disposition, confirmedReminders: preview.reminders })
    if (!result.ok) throw new Error(result.error.message)
    pendingDeletion.value = null
    await refresh()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '删除失败，请重新确认。'
    pendingDeletion.value = null
  } finally { busy.value = false }
}

function linkedCount(itemId: string): number {
  return reminders.value.filter((reminder) => reminder.itemId === itemId).length
}

function dueLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

let stopReminderEvents: (() => void) | null = null
onMounted(() => {
  void refresh()
  stopReminderEvents = window.seamoR1?.reminders.onDue(() => { void refresh() }) ?? null
})
onUnmounted(() => stopReminderEvents?.())
</script>

<template>
  <div class="items-overlay" @keydown.stop @keyup.stop>
    <section class="items-panel" aria-label="事项">
      <header class="items-header">
        <div>
          <p class="items-eyebrow">Seamo AI · 事项</p>
          <h2>把小事放在这里</h2>
          <p>便签与待办分别保存；完成待办时，专为催办设置且尚未投递的提醒会一起取消。</p>
        </div>
        <button class="items-quiet" type="button" @click="emit('close')">关闭</button>
      </header>

      <div class="items-content">
        <form class="items-create" @submit.prevent="createItem">
          <div class="items-kind" role="group" aria-label="事项类型">
            <button type="button" :aria-pressed="kind === 'note'" @click="kind = 'note'">便签</button>
            <button type="button" :aria-pressed="kind === 'todo'" @click="kind = 'todo'">待办</button>
          </div>
          <label>标题<input v-model="title" maxlength="80" placeholder="例如：给朋友回电话" /></label>
          <label>内容<textarea v-model="body" maxlength="8000" rows="3" placeholder="记下你想保留的细节" /></label>
          <button class="items-primary" type="submit" :disabled="busy || !title.trim() || !body.trim()">保存{{ kind === 'todo' ? '待办' : '便签' }}</button>
        </form>

        <div class="items-list-header"><h3>已保存</h3><span>{{ items.length }} 项</span></div>
        <p v-if="error" class="items-error" role="alert">{{ error }}</p>
        <p v-if="!items.length" class="items-empty">这里还没有事项。把刚才想到的一件事记下来。</p>
        <ul v-else class="items-list">
          <li v-for="item in items" :key="item.itemId" :class="{ completed: item.completedAt }">
            <button v-if="item.kind === 'todo'" class="items-check" type="button"
              :aria-label="item.completedAt ? `撤销完成 ${item.title}` : `完成 ${item.title}`"
              :disabled="busy" @click="toggleTodo(item)">{{ item.completedAt ? '✓' : '' }}</button>
            <span v-else class="items-note-mark">·</span>
            <div class="items-record"><strong>{{ item.title }}</strong><p>{{ item.body }}</p>
              <small>{{ item.kind === 'todo' ? '待办' : '便签' }}<template v-if="linkedCount(item.itemId)"> · {{ linkedCount(item.itemId) }} 条关联提醒</template></small>
            </div>
            <button class="items-quiet" type="button" :disabled="busy" @click="previewDeletion(item)">删除</button>
          </li>
        </ul>

        <div class="items-list-header"><h3>提醒</h3><span>{{ reminders.length }} 条</span></div>
        <form class="items-create" @submit.prevent="createReminder">
          <p class="items-form-hint">应用运行且 Mac 清醒时提醒。完全退出、关机或休眠期间无法保证准点。</p>
          <label>提醒内容<input v-model="reminderBody" maxlength="8000" placeholder="例如：给朋友回电话" /></label>
          <label>日期和时间<input v-model="reminderTime" type="datetime-local" required /></label>
          <label>关联事项
            <select v-model="reminderItemId"><option value="">独立提醒</option>
              <option v-for="item in items" :key="item.itemId" :value="item.itemId">{{ item.title }}</option>
            </select>
          </label>
          <label v-if="items.find((item) => item.itemId === reminderItemId)?.kind === 'todo'">关联目的
            <select v-model="reminderPurpose">
              <option value="independent">独立提醒；完成待办后仍保留</option>
              <option value="todo_due">专为催办；完成待办时取消未投递提醒</option>
            </select>
          </label>
          <button class="items-primary" type="submit" :disabled="busy || !reminderBody.trim() || !reminderTime">设置一次性提醒</button>
        </form>
        <ul v-if="reminders.length" class="items-list">
          <li v-for="reminder in reminders" :key="reminder.reminderId">
            <span class="items-note-mark">◦</span>
            <div class="items-record"><strong>{{ reminder.body }}</strong>
              <p>{{ dueLabel(reminder.dueAtUtc) }}</p>
              <small>{{ reminder.status === 'scheduled' ? '等待到期' : reminder.status === 'due' ? '已到期；不代表已读' : '已取消' }} · {{ reminder.linkPurpose === 'todo_due' ? '待办催办' : '独立提醒' }}</small>
              <div v-if="editingReminderId === reminder.reminderId" class="items-inline-edit">
                <input v-model="editedReminderTime" type="datetime-local" aria-label="新的提醒时间" />
                <button class="items-primary" type="button" :disabled="busy" @click="rescheduleReminder(reminder)">保存改期</button>
                <button class="items-quiet" type="button" @click="editingReminderId = ''">返回</button>
              </div>
            </div>
            <div v-if="reminder.status !== 'cancelled'" class="items-reminder-actions">
              <button class="items-quiet" type="button" :disabled="busy" @click="editingReminderId = reminder.reminderId">改期</button>
              <button class="items-quiet" type="button" :disabled="busy" @click="cancelReminder(reminder)">取消</button>
            </div>
          </li>
        </ul>
      </div>

      <div v-if="pendingDeletion" class="items-confirm" role="dialog" aria-modal="true" aria-label="确认删除事项">
        <div class="items-confirm-card">
          <h3>删除「{{ pendingDeletion.item.title }}」？</h3>
          <p v-if="pendingDeletion.reminders.length">它关联 {{ pendingDeletion.reminders.length }} 条提醒。默认保留提醒，删除后提醒仍会按原时间执行。</p>
          <p v-else>删除后，这条事项不会再出现在列表中。</p>
          <div class="items-confirm-actions">
            <button class="items-quiet" type="button" @click="pendingDeletion = null">返回</button>
            <button class="items-primary" type="button" :disabled="busy" @click="deleteItem('keep')">删除事项，保留提醒</button>
            <button v-if="pendingDeletion.reminders.some((reminder) => reminder.status === 'scheduled')" class="items-danger" type="button" :disabled="busy" @click="deleteItem('cancel')">连未到期提醒一起取消</button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.items-overlay{position:absolute;inset:0;z-index:35;display:flex;justify-content:flex-end;background:rgba(3,8,15,.55);backdrop-filter:blur(8px)}
.items-panel{position:relative;width:min(520px,100%);height:100%;overflow:hidden;display:flex;flex-direction:column;border-left:1px solid rgba(140,218,219,.18);background:linear-gradient(160deg,#111c29,#0c121d 58%,#11131d);box-shadow:-28px 0 90px rgba(0,0,0,.42);color:#f7f3e9}
.items-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:34px 34px 25px;border-bottom:1px solid rgba(255,255,255,.09)}
.items-eyebrow{margin:0 0 12px;color:#80d7d5;font-size:11px;letter-spacing:.18em;text-transform:uppercase}
h2{margin:0;font-family:"Songti SC",Georgia,serif;font-size:31px;font-weight:500;letter-spacing:.02em}
.items-header p:last-child{margin:13px 0 0;color:#aab6bc;font-size:12px;line-height:1.7}
.items-content{overflow:auto;padding:27px 34px 42px;scrollbar-color:#425863 transparent}
.items-create{display:grid;gap:14px;padding:22px;border:1px solid rgba(121,207,204,.18);border-radius:18px;background:rgba(109,199,196,.04)}
.items-kind{display:flex;gap:5px;padding:3px;border-radius:10px;background:#17222e;width:max-content}
.items-kind button{border:0;border-radius:7px;padding:7px 17px;background:transparent;color:#9eafb6;cursor:pointer}
.items-kind button[aria-pressed="true"]{background:#274450;color:#eafafa}
label{display:grid;gap:7px;font-size:12px;color:#b7c6c7}
input,textarea,select{width:100%;border:1px solid rgba(176,213,219,.22);border-radius:9px;background:#101822;color:#f7f3e9;padding:10px 12px;font:inherit;resize:vertical}
input:focus,textarea:focus,select:focus{outline:2px solid #82d8d7;outline-offset:1px}
.items-form-hint{margin:0;color:#8faeb2;font-size:12px;line-height:1.6}
.items-primary{border:0;border-radius:9px;background:#88d9d5;color:#09232b;padding:10px 17px;font-weight:650;cursor:pointer}
.items-primary:disabled{opacity:.45;cursor:not-allowed}
.items-quiet{border:0;background:transparent;color:#a8bbbd;cursor:pointer;padding:5px;white-space:nowrap;flex:none}
.items-quiet:hover{color:#fff}
.items-list-header{display:flex;align-items:baseline;justify-content:space-between;margin:32px 0 14px;border-bottom:1px solid rgba(255,255,255,.1);padding-bottom:10px}
.items-list-header h3{margin:0;font-size:15px;font-weight:600}.items-list-header span{color:#83a6aa;font-size:12px}
.items-empty{color:#9babaf;font-size:13px;line-height:1.6}.items-error{border-left:2px solid #eda988;padding:9px 12px;color:#f0bcaa;background:rgba(150,68,45,.14);font-size:12px}
.items-list{list-style:none;margin:0;padding:0}.items-list li{display:flex;align-items:flex-start;gap:13px;padding:17px 0;border-bottom:1px solid rgba(255,255,255,.08)}
.items-check,.items-note-mark{flex:none;width:23px;height:23px;border-radius:50%;border:1px solid #7dcac9;background:transparent;color:#b7e9e6;text-align:center;line-height:20px;cursor:pointer}
.items-note-mark{border-color:transparent;color:#d2b77e;font-size:24px;line-height:13px}
.items-record{min-width:0;flex:1}.items-record strong{font-size:14px;font-weight:600}.items-record p{margin:7px 0;color:#bac2c5;font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.items-record small{color:#78999d;font-size:11px}.completed .items-record strong{text-decoration:line-through;color:#93a2a5}
.items-reminder-actions{display:flex;flex-direction:column;gap:4px}.items-inline-edit{display:grid;gap:7px;margin-top:12px}.items-inline-edit .items-primary{justify-self:start}
.items-confirm{position:absolute;inset:0;display:grid;place-items:center;padding:24px;background:rgba(3,8,15,.77)}.items-confirm-card{width:100%;border:1px solid rgba(123,204,204,.24);border-radius:16px;background:#15212c;padding:25px;box-shadow:0 20px 70px rgba(0,0,0,.4)}
.items-confirm-card h3{margin:0 0 12px;font-family:"Songti SC",Georgia,serif;font-size:23px;font-weight:500}.items-confirm-card p{color:#b7c6c7;font-size:13px;line-height:1.7}.items-confirm-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px}.items-danger{border:1px solid #af786f;border-radius:9px;background:transparent;color:#f0b0a3;padding:9px 12px;cursor:pointer}
@media(max-width:700px){.items-header{padding:25px 20px}.items-content{padding:20px}.items-panel{width:100%}}
</style>
