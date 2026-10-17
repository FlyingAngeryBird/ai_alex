<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import type { DataCounts, RestorePreview } from '../../electron/main/r1/dataManagement'
import type { CleanupPreview } from '../../electron/main/r1/dataManagement'
import type { CleanupScope } from '../../electron/main/r1/dataCleanup'
import R1CleanupDialog from './R1CleanupDialog.vue'
const props = defineProps<{ diagnosticTrace?: () => unknown }>()
const emit = defineEmits<{ openHistory: [] }>()
const overview = ref<ReturnType<import('../../electron/main/r1/dataManagement').R1DataManagement['summary']> | null>(null)
const busy = ref(false), message = ref(''), error = ref(''), preview = ref<RestorePreview | null>(null), dialog = ref<HTMLElement | null>(null)
const cleanup = ref<CleanupPreview | null>(null), selectedScopes = ref<CleanupScope[]>([])
const scopeLabels: Array<[CleanupScope,string]> = [['history','普通对话历史'],['memory','记忆与持续话题'],['items','事项、提醒与专注'],['music','音乐收藏、队列与反馈'],['work','任务与工作稿']]
let disposed = false, generation = 0
const labels: Array<[keyof DataCounts, string]> = [['sessions', '会话'], ['messages', '消息'], ['memories', '记忆'], ['topics', '持续话题'],
  ['items', '事项'], ['reminders', '提醒'], ['tasks', '任务'], ['artifacts', '工作稿'], ['favorites', '音乐收藏'], ['queue', '队列'], ['feedback', '音乐反馈']]
function errorLabel(code: string): string {
  return ({ DATA_CHANGED_REVIEW_AGAIN: '当前数据已有变化，请重新选择备份并核对数量。', DATA_PREVIEW_EXPIRED: '确认已过期，请重新选择备份。',
    DATA_MAINTENANCE_BUSY: '另一项数据操作尚未结束，请稍后重试。', BACKUP_ALREADY_EXISTS: '目标文件已存在，请另选文件名。',
    BACKUP_SCHEMA_UNSUPPORTED: '该备份需要更新版本的应用，当前数据未改变。', BACKUP_RELATIONS_INVALID: '备份中的数据关系不完整，当前数据未改变。' } as Record<string, string>)[code] ?? '操作未完成，当前数据保留。可以重试或另选文件。'
}
async function run(action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  busy.value = true; error.value = ''; message.value = ''
  try { await action() } catch { if (!disposed) error.value = '数据操作未完成，请重试。' } finally { if (!disposed) busy.value = false }
}
async function refresh(): Promise<void> {
  const result = await window.seamoR1.data.summary()
  if (disposed) return
  if (result.ok) overview.value = result.data; else error.value = errorLabel(result.error.code)
}
async function exportFile(kind: 'backup' | 'diagnostic'): Promise<void> {
  await run(async () => {
    const result = kind === 'backup' ? await window.seamoR1.data.exportBackup() : await window.seamoR1.data.exportDiagnostics({ voiceTrace: props.diagnosticTrace?.() ?? null })
    if (disposed) return
    if (!result.ok) { error.value = errorLabel(result.error.code); return }
    if (!result.data.cancelled) message.value = `${kind === 'backup' ? '内容备份' : '诊断'}已写入 ${result.data.fileName}`
  })
}
async function prepareRestore(): Promise<void> {
  const request = ++generation
  await run(async () => {
    const result = await window.seamoR1.data.prepareRestore()
    if (disposed || request !== generation) return
    if (!result.ok) { error.value = errorLabel(result.error.code); return }
    if (!result.data.cancelled) { preview.value = result.data.preview; await nextTick(); dialog.value?.focus() }
  })
}
function cancelRestore(): void { generation++; preview.value = null; void window.seamoR1.data.cancelRestore().catch(() => undefined) }
function trapFocus(event: KeyboardEvent): void {
  if (event.key !== 'Tab' || !dialog.value) return
  const buttons = [...dialog.value.querySelectorAll<HTMLElement>('button:not(:disabled)')]
  const first = buttons[0], last = buttons.at(-1)
  if (!first || !last) { event.preventDefault(); dialog.value.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.value)) { event.preventDefault(); first.focus() }
}
async function confirmRestore(): Promise<void> {
  const selected = preview.value
  if (!selected) return
  await run(async () => {
    const result = await window.seamoR1.data.confirmRestore({ ticket: selected.ticket, confirmed: true })
    if (disposed) return
    if (!result.ok) { error.value = errorLabel(result.error.code); cancelRestore(); return }
    preview.value = null; message.value = '已确认，正在停止服务并重新启动。重启后可在此查看实际恢复结果。'
  })
}
async function prepareCleanup(): Promise<void> {
  await run(async () => {
    const result = await window.seamoR1.data.prepareCleanup({ scopes: [...selectedScopes.value] })
    if (disposed) return
    if (!result.ok) { error.value = errorLabel(result.error.code); return }
    cleanup.value = result.data
  })
}
function cancelCleanup(): void { cleanup.value = null; void window.seamoR1.data.cancelRestore().catch(() => undefined) }
async function confirmCleanup(): Promise<void> {
  const selected = cleanup.value
  if (!selected) return
  await run(async () => {
    const result = await window.seamoR1.data.confirmCleanup({ ticket: selected.ticket, confirmed: true })
    if (disposed) return
    if (!result.ok) { error.value = errorLabel(result.error.code); cancelCleanup(); return }
    cleanup.value = null; message.value = '已确认，正在保存清理前副本并重新启动。'
  })
}
async function exportCleanupBackup(): Promise<void> {
  await run(async () => {
    const result = await window.seamoR1.data.exportCleanupBackup()
    if (disposed) return
    if (!result.ok) { error.value = errorLabel(result.error.code); return }
    if (!result.data.cancelled) message.value = `清理前副本已导出至 ${result.data.fileName}`
  })
}
onBeforeUnmount(() => { disposed = true; cancelRestore() })
</script>

<template>
  <section class="r1-settings-section r1-data-settings">
    <details @toggle="($event.target as HTMLDetailsElement).open && run(refresh)">
      <summary>数据与诊断</summary>
      <button type="button" class="r1-data-link" @click="emit('openHistory')">查看历史对话</button>
      <p v-if="overview">当前有 {{ overview.counts.sessions }} 段会话、{{ overview.counts.memories }} 条记忆、{{ overview.counts.items }} 条事项、{{ overview.counts.favorites }} 首收藏。</p>
      <div class="r1-data-actions"><button type="button" :disabled="busy" @click="exportFile('backup')">导出内容备份</button><button type="button" :disabled="busy" @click="prepareRestore">从备份恢复…</button><button type="button" :disabled="busy" @click="exportFile('diagnostic')">导出诊断</button></div>
      <p>内容备份包含普通历史、记忆、事项、音乐个人数据、任务、工作稿、非密钥设置和删除元数据。文件未加密，不包含服务凭据或原始音频。</p>
      <p>恢复会先核对范围与数量，并在停止服务后覆盖内容、重新启动；保留当前凭据、设备、安静模式及自动记忆授权。已遗忘来源仍受抑制。</p>
      <p>诊断仅含版本、服务配置状态、检测错误码与阶段时间，不含聊天正文、原始音频或密钥。由你选择文件位置，本应用不会自动上传。</p>
      <p v-if="overview?.lastRestore" role="status">上次恢复：{{ overview.lastRestore.status === 'succeeded' ? '已完成，已保留覆盖前副本' : '未完成，当前数据保留' }} · {{ new Date(overview.lastRestore.completedAt).toLocaleString() }}</p>
      <fieldset :disabled="busy"><legend>选择清理范围</legend><label v-for="[scope,label] in scopeLabels" :key="scope" class="r1-cleanup-scope"><input v-model="selectedScopes" type="checkbox" :value="scope" />{{ label }}</label></fieldset>
      <div class="r1-data-actions"><button type="button" :disabled="busy || !selectedScopes.length" @click="prepareCleanup">预览所选清理范围…</button><button v-if="overview?.lastCleanup?.rollbackFileName" type="button" :disabled="busy" @click="exportCleanupBackup">导出清理前副本</button></div>
      <p v-if="overview?.lastCleanup" role="status">上次清理：{{ overview.lastCleanup.status === 'succeeded' ? '已完成' : '未完成，当前数据保留' }} · {{ new Date(overview.lastCleanup.completedAt).toLocaleString() }}</p>
      <p v-if="busy" role="status">正在处理数据操作…</p><p v-if="message" role="status">{{ message }}</p><p v-if="error" role="alert">{{ error }}</p>
    </details>
    <R1CleanupDialog v-if="cleanup" :preview="cleanup" :busy="busy" :error="error" @cancel="cancelCleanup" @confirm="confirmCleanup" />
    <Teleport to="body">
      <div v-if="preview" class="r1-memory-modal-backdrop r1-data-confirm" @keydown.stop="trapFocus" @keydown.esc="!busy && cancelRestore()">
        <section ref="dialog" class="r1-memory-modal" role="dialog" aria-modal="true" aria-labelledby="r1-restore-title" tabindex="-1">
          <h3 id="r1-restore-title">确认覆盖恢复</h3><p>备份：{{ preview.fileName }}</p><p>以下用户内容将被备份覆盖。先保留当前数据库副本；失败时继续使用当前数据。</p>
          <div class="r1-restore-counts"><table><thead><tr><th>内容</th><th>当前</th><th>备份</th></tr></thead><tbody><tr v-for="[key, label] in labels" :key="key"><th>{{ label }}</th><td>{{ preview.current[key] }}</td><td>{{ preview.incoming[key] }}</td></tr></tbody></table></div>
          <p>当前服务凭据、设备、勿扰和自动记忆授权保留。备份的人格与其他非密钥设置一并恢复；当前删除抑制记录合并保留。未完成任务重启后需由你选择继续，不自动重新执行。</p>
          <div class="r1-memory-dialog-actions"><button type="button" :disabled="busy" @click="cancelRestore">取消</button><button type="button" :disabled="busy" @click="confirmRestore">确认恢复并重启</button></div>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.r1-data-link{margin-top:16px;border:0;background:none;color:var(--r1-aqua);font-size:12px}
.r1-cleanup-scope{display:flex;align-items:center;gap:8px;margin:9px 0;font-size:12px}fieldset{margin-top:18px;border:1px solid var(--r1-line);border-radius:6px}legend{font-size:12px;color:var(--r1-aqua)}
.r1-data-actions{display:flex;flex-wrap:wrap;gap:9px;margin:14px 0}.r1-data-actions button{min-height:32px;padding:5px 9px;border:1px solid var(--r1-line);border-radius:5px;background:#171d1d;color:var(--r1-aqua);font-size:11px}.r1-data-actions button:disabled{opacity:.45}
.r1-data-confirm{position:fixed;z-index:90}.r1-data-confirm .r1-memory-modal{max-height:calc(100vh - 48px);overflow:auto}.r1-restore-counts{max-height:245px;overflow:auto;margin:15px 0}.r1-restore-counts table{width:100%;border-collapse:collapse;font-size:12px}.r1-restore-counts th,.r1-restore-counts td{padding:7px;text-align:left;border-bottom:1px solid var(--r1-line);font-weight:400}.r1-restore-counts thead{color:var(--r1-aqua)}
</style>
