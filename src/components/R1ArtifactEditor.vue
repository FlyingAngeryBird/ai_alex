<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Artifact } from '../../electron/main/r1/artifacts'
import type { Item } from '../../electron/main/r1/items'
const props = defineProps<{ artifactId: string }>()
const artifact = ref<Artifact | null>(null)
const title = ref('')
const body = ref('')
const busy = ref(false)
const activeAction = ref('')
const editingLocked = computed(() => busy.value && activeAction.value !== 'apply')
const error = ref('')
const notice = ref('')
const confirmSave = ref(false)
const saveKind = ref<'note' | 'todo'>('note')
const conflictingItem = ref<Item | null>(null)
const undoVersion = ref<number | null>(null)
const dirty = computed(() => !!artifact.value && (title.value !== artifact.value.title || body.value !== artifact.value.content))
let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  if (!dirty.value || !title.value.trim() || !body.value.trim() || busy.value) return
  saveTimer = setTimeout(() => { saveTimer = null; void run('apply') }, 600)
}
watch([title, body], scheduleSave)
onBeforeUnmount(() => { if (saveTimer) clearTimeout(saveTimer) })
function accept(value: Artifact): void { artifact.value = value; title.value = value.title; body.value = value.content }
async function load(): Promise<void> {
  try {
    const result = await window.seamoR1.artifacts.get({ artifactId: props.artifactId })
    if (!result.ok) throw new Error(result.error.code)
    accept(result.data)
  } catch { error.value = '工作稿暂时无法读取。' }
}
async function apply(): Promise<boolean> {
  if (!artifact.value) return false
  if (title.value === artifact.value.title && body.value === artifact.value.content) return true
  const previous = artifact.value.version
  const submittedTitle = title.value
  const submittedBody = body.value
  const result = await window.seamoR1.artifacts.revise({ artifactId: props.artifactId,
    expectedVersion: previous, title: submittedTitle, content: submittedBody })
  if (!result.ok) throw new Error(result.error.code)
  undoVersion.value = previous
  artifact.value = result.data
  if (title.value === submittedTitle && body.value === submittedBody) accept(result.data)
  return true
}
async function run(action: 'apply' | 'undo' | 'save' | 'replace' | 'copy' | 'txt' | 'md'): Promise<void> {
  if (busy.value || !artifact.value) return
  if (action === 'replace' && !conflictingItem.value) return
  if ((action === 'save' || action === 'replace') && artifact.value.temporary && !confirmSave.value) { confirmSave.value = true; return }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  activeAction.value = action
  busy.value = true; error.value = ''; notice.value = ''
  try {
    if (action === 'copy') { await navigator.clipboard.writeText(body.value); notice.value = '已复制'; return }
    if (action === 'undo' && undoVersion.value !== null) {
      const result = await window.seamoR1.artifacts.undo({ artifactId: props.artifactId,
        expectedVersion: artifact.value.version, restoreVersion: undoVersion.value })
      if (!result.ok) throw new Error(result.error.code)
      accept(result.data); undoVersion.value = null; notice.value = '已撤销'; return
    }
    if (!await apply()) return
    if (action === 'txt' || action === 'md') {
      const result = await window.seamoR1.artifacts.export({ artifactId: props.artifactId,
        expectedVersion: artifact.value.version, format: action })
      if (!result.ok) throw new Error(result.error.code)
      notice.value = result.data.cancelled ? '已取消导出' : `已导出版本 ${result.data.version}`
      return
    }
    if (action === 'save' || action === 'replace') {
      const expectedItemVersion = action === 'replace' ? conflictingItem.value!.version : artifact.value.savedItemVersion ?? undefined
      const result = await window.seamoR1.artifacts.save({ artifactId: props.artifactId,
        expectedVersion: artifact.value.version, actionId: crypto.randomUUID(), expectedItemVersion,
        replacementConfirmed: action === 'replace',
        kind: artifact.value.savedItemId ? undefined : saveKind.value, temporarySaveConfirmed: confirmSave.value })
      if (!result.ok) throw new Error(result.error.code)
      artifact.value.savedItemId = result.data.item.itemId
      artifact.value.savedItemVersion = result.data.item.version
      conflictingItem.value = null
      confirmSave.value = false; notice.value = result.data.item.kind === 'todo' ? '已保存为待办' : '已保存为便签'
    } else if (!dirty.value) notice.value = '修改已保留'
  } catch (cause) {
    error.value = cause instanceof Error && cause.message === 'VERSION_CONFLICT'
      ? '工作稿或记录已有新版本。你的文字仍在此处，请保留后重新打开核对。' : '操作未完成，你的文字仍在此处，请重试。'
    if ((action === 'save' || action === 'replace') && artifact.value.savedItemId) {
      try {
        const result = await window.seamoR1.items.list()
        if (result.ok) conflictingItem.value = result.data.find(item => item.itemId === artifact.value?.savedItemId) ?? null
      } catch { /* Keep the local draft; a failed read never authorizes replacement. */ }
    }
  } finally { busy.value = false; if (!error.value) scheduleSave() }
}
onMounted(load)
</script>
<template>
  <section class="r1-artifact-editor" aria-label="工作稿编辑">
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="artifact">
      <div class="editor-heading"><span>讨论稿</span><small>{{ dirty ? (busy ? '正在保留…' : '修改待保留') : '草稿 · 已保留' }} · 版本 {{ artifact.version }}</small></div>
      <input v-model="title" class="editor-title" aria-label="工作稿标题" :disabled="editingLocked" maxlength="80" />
      <textarea v-model="body" class="editor-body" aria-label="工作稿正文" :disabled="editingLocked" rows="12" />
      <label v-if="!artifact.savedItemId" class="editor-save-kind">保存类型
        <select v-model="saveKind" :disabled="busy || confirmSave" aria-label="工作稿保存类型"><option value="note">便签</option><option value="todo">待办</option></select>
      </label>
      <div class="editor-actions"><button :disabled="busy" @click="run('apply')">保留修改</button>
        <button :disabled="busy || undoVersion === null" @click="run('undo')">撤销修改</button>
        <button :disabled="busy" @click="run('copy')">复制</button><button :disabled="busy" @click="run('save')">保存为记录</button><button :disabled="busy" @click="run('txt')">导出 TXT</button><button :disabled="busy" @click="run('md')">导出 Markdown</button></div>
      <div v-if="confirmSave" class="editor-confirm"><p>将这份临时工作稿保存到{{ saveKind === 'todo' ? '待办' : '便签' }}，结束临时对话后仍会保留。</p>
        <button :disabled="busy" @click="run('save')">确认保存</button><button :disabled="busy" @click="confirmSave = false">取消</button></div>
      <div v-if="conflictingItem" class="editor-confirm" aria-label="核对已有记录">
        <p>已有记录的当前内容：</p><strong>{{ conflictingItem.title }}</strong><p class="conflict-body">{{ conflictingItem.body }}</p>
        <button :disabled="busy" @click="run('replace')">用当前工作稿更新此记录</button>
        <button :disabled="busy" @click="conflictingItem = null">保留已有记录</button>
      </div>
      <p v-if="notice" role="status">{{ notice }}</p>
    </template>
  </section>
</template>
<style scoped>
.r1-artifact-editor{padding:24px 0}.editor-heading{display:flex;justify-content:space-between;color:#89978f;font-size:11px}.editor-title,.editor-body{display:block;width:100%;border:0;background:transparent;color:var(--r1-text);outline:none}.editor-title{font-size:23px;padding:18px 0}.editor-body{resize:vertical;min-height:240px;font-size:14px;line-height:1.9}.editor-actions{display:flex;flex-wrap:wrap;gap:16px;border-top:1px solid var(--r1-line);padding-top:16px}button{border:0;background:none;color:var(--r1-aqua);font-size:12px;cursor:pointer}button:disabled{opacity:.4;cursor:default}p{font-size:12px;line-height:1.8}.editor-confirm{padding:14px;border:1px solid var(--r1-line);margin-top:16px}.editor-confirm button{margin-right:16px}
</style>
