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
const scopeOptions: Array<{ scope: CleanupScope; label: string; note: string }> = [
  { scope: 'history', label: '普通对话历史', note: '聊天记录；独立记忆仍保留' },
  { scope: 'memory', label: '记忆与持续话题', note: '已保存的个人信息与话题' },
  { scope: 'items', label: '事项、提醒与专注', note: '包含尚未触发的提醒' },
  { scope: 'music', label: '音乐收藏与记录', note: '收藏、队列与喜好反馈' },
  { scope: 'work', label: '委托与工作稿', note: '任务记录与可编辑内容' }
]
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
defineExpose({ canLeave: () => !busy.value && !preview.value && !cleanup.value })
onBeforeUnmount(() => { disposed = true; cancelRestore() })
</script>

<template>
  <section class="r1-settings-section r1-data-settings">
    <details @toggle="($event.target as HTMLDetailsElement).open && run(refresh)">
      <summary>数据与诊断</summary>
      <p class="r1-data-overview" v-if="overview">本机有 {{ overview.counts.sessions }} 段对话、{{ overview.counts.memories }} 条记忆、{{ overview.counts.items }} 条事项、{{ overview.counts.favorites }} 首收藏。</p>
      <button type="button" class="r1-data-link" @click="emit('openHistory')">查看历史对话 <span aria-hidden="true">↗</span></button>
      <div class="r1-data-tools">
        <div class="r1-data-tool">
          <div><strong>备份本机内容</strong><p>保存历史、记忆、事项、音乐记录、委托、工作稿和非密钥设置。备份文件未加密，不含密钥或原始音频。</p></div>
          <button type="button" :disabled="busy" @click="exportFile('backup')">导出备份…</button>
        </div>
        <div class="r1-data-tool">
          <div><strong>从备份恢复</strong><p>先核对范围和数量，再确认覆盖。当前数据会留副本；凭据、设备和授权设置保留。</p></div>
          <button type="button" :disabled="busy" @click="prepareRestore">选择备份…</button>
        </div>
        <div class="r1-data-tool">
          <div><strong>导出诊断</strong><p>仅含版本、服务状态和错误阶段；不含聊天正文、音频或密钥，也不会自动上传。</p></div>
          <button type="button" :disabled="busy" @click="exportFile('diagnostic')">导出诊断…</button>
        </div>
      </div>
      <p v-if="overview?.lastRestore" role="status">上次恢复：{{ overview.lastRestore.status === 'succeeded' ? '已完成，已保留覆盖前副本' : '未完成，当前数据保留' }} · {{ new Date(overview.lastRestore.completedAt).toLocaleString() }}</p>
      <details class="r1-data-cleanup">
        <summary><span>清理本地内容</span><small>按类型选择，先预览再确认</small></summary>
        <p class="r1-cleanup-intro">只清理你选择的内容。未选内容和服务凭据保持不变。</p>
        <fieldset class="r1-cleanup-options" :disabled="busy"><legend>选择要清理的内容</legend>
          <label v-for="option in scopeOptions" :key="option.scope" class="r1-cleanup-option">
            <input v-model="selectedScopes" type="checkbox" :value="option.scope" />
            <span><strong>{{ option.label }}</strong><small>{{ option.note }}</small></span>
          </label>
        </fieldset>
        <button type="button" class="r1-cleanup-preview" :disabled="busy || !selectedScopes.length" @click="prepareCleanup">预览所选内容</button>
        <button v-if="overview?.lastCleanup?.rollbackFileName" type="button" class="r1-data-link" :disabled="busy" @click="exportCleanupBackup">导出清理前副本</button>
        <p v-if="overview?.lastCleanup" role="status">上次清理：{{ overview.lastCleanup.status === 'succeeded' ? '已完成' : '未完成，当前数据保留' }} · {{ new Date(overview.lastCleanup.completedAt).toLocaleString() }}</p>
      </details>
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
.r1-data-overview{margin:15px 0 0!important;color:#c0ccc4!important;font-size:12px!important}
.r1-data-link{display:inline-flex;align-items:center;gap:5px;margin:8px 0 15px;padding:0;border:0;background:none;color:var(--r1-aqua);font:inherit;font-size:12px;text-align:left}
.r1-data-link:hover{text-decoration:underline;text-underline-offset:3px}.r1-data-link:disabled{opacity:.45}
.r1-data-tools{display:grid;gap:8px;margin:5px 0 20px}.r1-data-tool{padding:13px 14px;border:1px solid var(--r1-line);border-radius:8px;background:rgba(255,255,255,.025)}
.r1-data-tool strong{display:block;color:#e8eee7;font-size:12px;font-weight:500}.r1-data-tool p{margin:5px 0 11px!important;line-height:1.55!important}
.r1-data-tool button,.r1-cleanup-preview{min-height:34px;padding:6px 11px;border:1px solid #526960;border-radius:6px;background:#1d302b;color:var(--r1-aqua);font:inherit;font-size:12px}.r1-data-tool button:hover,.r1-cleanup-preview:hover:not(:disabled){background:#264239}.r1-data-tool button:disabled,.r1-cleanup-preview:disabled{opacity:.45;cursor:default}
.r1-data-cleanup{margin-top:18px!important;padding-top:17px;border-top:1px solid var(--r1-line)}.r1-data-cleanup>summary{display:flex;align-items:baseline;justify-content:space-between;gap:10px;color:#e7eee7!important;font-size:13px!important;list-style:none}.r1-data-cleanup>summary::-webkit-details-marker{display:none}.r1-data-cleanup>summary:after{content:'⌄';color:var(--r1-aqua);font-size:17px;line-height:1}.r1-data-cleanup[open]>summary:after{transform:rotate(180deg)}.r1-data-cleanup>summary small{margin-left:auto;color:#8d9d95;font-size:10px}.r1-data-cleanup>summary:focus-visible{outline:2px solid var(--r1-aqua);outline-offset:4px;border-radius:3px}
.r1-cleanup-intro{margin:14px 0 10px!important}.r1-cleanup-options{min-width:0;margin:0;padding:0;border:1px solid var(--r1-line);border-radius:8px;overflow:hidden}.r1-cleanup-options legend{padding:0 4px;color:var(--r1-aqua);font-size:11px}.r1-data-settings .r1-cleanup-option{display:grid;grid-template-columns:18px minmax(0,1fr);align-items:center;gap:12px;margin:0;padding:11px 12px;color:#cbd6cf;cursor:pointer}.r1-cleanup-option+.r1-cleanup-option{border-top:1px solid var(--r1-line)}.r1-cleanup-option:hover{background:rgba(161,217,207,.045)}
.r1-data-settings .r1-cleanup-option input[type=checkbox]{box-sizing:border-box;appearance:none;display:block;flex:none;width:18px;min-width:18px;height:18px;min-height:18px;margin:0;padding:0;border:1px solid #667b72;border-radius:4px;background:#111a18;cursor:pointer}.r1-data-settings .r1-cleanup-option input[type=checkbox]:checked{border-color:var(--r1-aqua);background:var(--r1-aqua)}.r1-data-settings .r1-cleanup-option input[type=checkbox]:checked::after{content:'';display:block;width:8px;height:4px;margin:4px 0 0 3px;border:solid #102720;border-width:0 0 2px 2px;transform:rotate(-45deg)}
.r1-cleanup-option strong,.r1-cleanup-option small{display:block}.r1-cleanup-option strong{font-size:12px;font-weight:500;line-height:1.4}.r1-cleanup-option small{margin-top:2px;color:#81958b;font-size:10px;line-height:1.4}.r1-cleanup-options:disabled .r1-cleanup-option{opacity:.5;cursor:default}.r1-cleanup-preview{width:100%;margin-top:12px}
.r1-data-confirm{position:fixed;z-index:90}.r1-data-confirm .r1-memory-modal{max-height:calc(100vh - 48px);overflow:auto}.r1-restore-counts{max-height:245px;overflow:auto;margin:15px 0}.r1-restore-counts table{width:100%;border-collapse:collapse;font-size:12px}.r1-restore-counts th,.r1-restore-counts td{padding:7px;text-align:left;border-bottom:1px solid var(--r1-line);font-weight:400}.r1-restore-counts thead{color:var(--r1-aqua)}
</style>
