<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Artifact } from '../../electron/main/r1/artifacts'
import type { Item } from '../../electron/main/r1/items'
import type { SessionMessage } from '../../electron/main/r1/conversations'
import runtimeDefaults from '../../r1-assets/config/runtime.defaults.json'
const props = withDefaults(defineProps<{ artifactId: string; active?: boolean }>(), { active: true })
const artifact = ref<Artifact | null>(null)
const title = ref('')
const body = ref('')
const busy = ref(false)
const flushing = ref(false)
const activeAction = ref('')
const editingLocked = computed(() => flushing.value || busy.value && activeAction.value !== 'apply')
const error = ref('')
const notice = ref('')
const confirmSave = ref(false)
const saveKind = ref<'note' | 'todo'>('note')
const conflictingItem = ref<Item | null>(null)
const incomingArtifact = ref<Artifact | null>(null)
const undoVersion = ref<number | null>(null)
const materials = ref<SessionMessage[]>([]), materialsOpen = ref(false), materialsLoading = ref(false), materialsError = ref('')
const bodyInput = ref<HTMLTextAreaElement | null>(null)
const editorRoot = ref<HTMLElement | null>(null)
const validationError = computed(() => [...title.value].length > runtimeDefaults.limits.titleCodePoints
  ? `标题最多 ${runtimeDefaults.limits.titleCodePoints} 个字，当前文字已保留，请缩短后重试。`
  : [...body.value].length > runtimeDefaults.limits.textCodePoints ? `正文最多 ${runtimeDefaults.limits.textCodePoints} 个字，当前文字已保留，请分段处理。` : '')
let stopChanges: (() => void) | undefined, disposed = false, pendingVersion = 0, selectionGeneration = 0, loadGeneration = 0
let actionSettled: Promise<void> = Promise.resolve()
const dirty = computed(() => !!artifact.value && (title.value !== artifact.value.title || body.value !== artifact.value.content))
let saveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  if (error.value || validationError.value || !dirty.value || !title.value.trim() || !body.value.trim() || busy.value) return
  saveTimer = setTimeout(() => { saveTimer = null; void run('apply') }, 600)
}
watch([title, body], scheduleSave)
onBeforeUnmount(() => { disposed = true; selectionGeneration++; stopChanges?.(); if (saveTimer) clearTimeout(saveTimer) })
function accept(value: Artifact): void { artifact.value = value; title.value = value.title; body.value = value.content }
async function load(): Promise<void> {
  const request = ++loadGeneration
  try {
    const result = await window.seamoR1.artifacts.get({ artifactId: props.artifactId })
    if (disposed || request !== loadGeneration) return
    if (!result.ok) throw new Error(result.error.code)
    if (artifact.value && (dirty.value || busy.value)) {
      if (result.data.version > artifact.value.version) { incomingArtifact.value = result.data; error.value = '工作稿已有新版本。你的文字仍在此处，请先核对。' }
      return
    }
    if (artifact.value && result.data.version < artifact.value.version) return
    error.value = ''; incomingArtifact.value = null
    accept(result.data); undoVersion.value = result.data.version > 1 ? result.data.version - 1 : null
    if (props.active) await selectCurrent()
  } catch { error.value = '工作稿暂时无法读取。' }
}
async function selectCurrent(fromSelection = false): Promise<void> {
  if (!artifact.value || dirty.value || busy.value || disposed || !window.seamoR1.artifacts.select) return
  if (!props.active && !editorRoot.value?.contains(document.activeElement)) return
  const request = ++selectionGeneration
  const node = fromSelection ? bodyInput.value : null
  const start = node ? [...body.value.slice(0, node.selectionStart)].length : 0
  const end = node ? [...body.value.slice(0, node.selectionEnd)].length : 0
  const result = await window.seamoR1.artifacts.select({ artifactId: props.artifactId, expectedVersion: artifact.value.version,
    selection: end > start ? { start, end } : null })
  if (!disposed && request === selectionGeneration && !result.ok) error.value = '当前工作稿已有变化，请重新打开核对。'
}
async function showMaterials(): Promise<void> {
  materialsOpen.value = !materialsOpen.value
  if (!materialsOpen.value) return
  materialsLoading.value = true; materialsError.value = ''
  try {
    const result = await window.seamoR1.artifacts.materials(props.artifactId)
    if (disposed) return
    if (!result.ok) throw new Error(result.error.code)
    materials.value = result.data
  } catch { if (!disposed) materialsError.value = '原始材料暂时无法读取，请重试。' }
  finally { if (!disposed) materialsLoading.value = false }
}
async function refreshPublished(): Promise<void> {
  if (disposed || busy.value || !artifact.value || pendingVersion <= artifact.value.version) return
  await load()
}
watch(() => props.active, value => { if (value) void selectCurrent() })
async function apply(): Promise<boolean> {
  if (!artifact.value) return false
  if (validationError.value) throw new Error('ARTIFACT_INPUT_LIMIT')
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
function useIncoming(): void {
  if (busy.value || !incomingArtifact.value) return
  const current = incomingArtifact.value; accept(current); incomingArtifact.value = null; error.value = ''
  undoVersion.value = current.version > 1 ? current.version - 1 : null
  if (props.active) void selectCurrent()
}
async function run(action: 'apply' | 'reviewedApply' | 'undo' | 'save' | 'replace' | 'copy' | 'txt' | 'md'): Promise<void> {
  if (busy.value || !artifact.value) return
  if (action === 'reviewedApply' && !incomingArtifact.value) return
  if (action === 'replace' && !conflictingItem.value) return
  if ((action === 'save' || action === 'replace') && artifact.value.temporary && !confirmSave.value) { confirmSave.value = true; return }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  activeAction.value = action
  let settle!: () => void
  actionSettled = new Promise(resolve => { settle = resolve })
  busy.value = true; error.value = ''; notice.value = ''
  try {
    if (action === 'copy') { await navigator.clipboard.writeText(body.value); notice.value = '已复制'; return }
    if (action === 'reviewedApply') { artifact.value = incomingArtifact.value!; incomingArtifact.value = null }
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
    error.value = validationError.value || (cause instanceof Error && cause.message === 'VERSION_CONFLICT'
      ? '工作稿或记录已有新版本。你的文字仍在此处，请先核对。' : '操作未完成，你的文字仍在此处，请重试。')
    if (cause instanceof Error && cause.message === 'VERSION_CONFLICT') {
      try { const result = await window.seamoR1.artifacts.get({ artifactId: props.artifactId }); if (result.ok && result.data.version > artifact.value!.version) incomingArtifact.value = result.data } catch { /* Preserve local text when the current version cannot be read. */ }
    }
    if ((action === 'save' || action === 'replace') && artifact.value.savedItemId) {
      try {
        const result = await window.seamoR1.items.list()
        if (result.ok) conflictingItem.value = result.data.find(item => item.itemId === artifact.value?.savedItemId) ?? null
      } catch { /* Keep the local draft; a failed read never authorizes replacement. */ }
    }
  } finally { busy.value = false; settle(); if (!error.value) { scheduleSave(); if (props.active) void selectCurrent(); void refreshPublished() } }
}
async function flush(): Promise<boolean> {
  flushing.value = true
  try {
    await actionSettled
    if (disposed || !artifact.value || incomingArtifact.value || validationError.value) return false
    if (dirty.value) await run('apply')
    return !dirty.value && !incomingArtifact.value && !error.value
  } finally { flushing.value = false }
}
defineExpose({ flush })
onMounted(() => {
  stopChanges = window.seamoR1.artifacts.onChanged?.(event => {
    if (event.artifactId !== props.artifactId || disposed) return
    pendingVersion = Math.max(pendingVersion, event.version); void refreshPublished()
  })
  void load()
})
</script>
<template>
  <section ref="editorRoot" class="r1-artifact-editor" aria-label="工作稿编辑">
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="validationError && validationError !== error" role="alert">{{ validationError }}</p>
    <template v-if="artifact">
      <button type="button" class="work-source-toggle" :aria-expanded="materialsOpen" @click="showMaterials">{{ materialsOpen ? '收起原始想法' : '查看原始想法' }}</button>
      <section v-if="materialsOpen" class="editor-materials" aria-label="原始想法">
        <p v-if="materialsLoading" role="status">正在读取…</p><p v-else-if="materialsError" role="alert">{{ materialsError }}</p>
        <p v-else-if="!materials.length">这份稿件没有可查看的原始材料记录。</p>
        <article v-for="material in materials" :key="material.messageId"><small>{{ new Date(material.createdAt).toLocaleString() }}</small><p>{{ material.body }}</p></article>
      </section>
      <div class="editor-heading"><span>讨论稿</span><small>{{ dirty ? (busy ? '正在保留…' : '修改待保留') : '草稿 · 已保留' }} · 版本 {{ artifact.version }}</small></div>
      <input v-model="title" class="editor-title" aria-label="工作稿标题" :disabled="editingLocked" @focus="selectCurrent()" />
      <textarea ref="bodyInput" v-model="body" class="editor-body" aria-label="工作稿正文" :disabled="editingLocked" rows="12" @focus="selectCurrent(true)" @select="selectCurrent(true)" />
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
      <div v-if="incomingArtifact" class="editor-confirm" aria-label="核对工作稿新版本">
        <p>工作稿当前为版本 {{ incomingArtifact.version }}，请核对新内容：</p><strong>{{ incomingArtifact.title }}</strong><p class="conflict-body">{{ incomingArtifact.content }}</p>
        <button :disabled="busy || !!validationError" @click="run('reviewedApply')">用我的文字更新此版本</button><button :disabled="busy" @click="useIncoming">采用新版本</button>
      </div>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p class="editor-hint">在对话输入框说“第二段短一些”，只修改对应段落。也可以先选中正文，再说明要怎样修改。</p>
    </template>
  </section>
</template>
<style scoped>
.work-source-toggle{display:inline-flex;align-items:center;gap:8px;margin-bottom:20px;color:#9db5a3;font-size:11px}.editor-materials{padding:14px 0;border-bottom:1px solid var(--r1-line);margin-bottom:18px}.editor-materials p,.conflict-body{white-space:pre-wrap;overflow-wrap:anywhere}.conflict-body{max-height:240px;overflow:auto}.editor-materials small,.editor-hint{color:#84968a}.editor-hint{font-size:11px;margin-top:15px}
.r1-artifact-editor{padding:24px 0}.editor-heading{display:flex;justify-content:space-between;color:#89978f;font-size:11px}.editor-title,.editor-body{display:block;width:100%;border:0;background:transparent;color:var(--r1-text);outline:none}.editor-title{font-size:23px;padding:18px 0}.editor-body{resize:vertical;min-height:240px;font-size:14px;line-height:1.9}.editor-actions{display:flex;flex-wrap:wrap;gap:16px;border-top:1px solid var(--r1-line);padding-top:16px}button{border:0;background:none;color:var(--r1-aqua);font-size:12px;cursor:pointer}button:disabled{opacity:.4;cursor:default}p{font-size:12px;line-height:1.8}.editor-confirm{padding:14px;border:1px solid var(--r1-line);margin-top:16px}.editor-confirm button{margin-right:16px}
</style>
