<template>
  <section class="backup-versions">
    <div class="backup-section-heading"><div><h3>文件版本</h3><p class="backup-muted">只有“可恢复”的完整版本能用于恢复。源文件删除不会自动删除历史版本。</p></div><button class="backup-text-button" type="button" :disabled="listLoading" @click="loadSnapshots(page)">刷新版本</button></div>
    <p v-if="listError" class="backup-error" role="alert">{{ listError }}</p><div v-if="listLoading" class="backup-empty" role="status">正在读取版本…</div><div v-else-if="!snapshots.length && !listError" class="backup-empty">还没有文件版本。先生成并执行备份预演。</div>
    <div v-else-if="snapshots.length" class="backup-table-scroll"><table class="backup-table snapshot-table"><thead><tr><th class="backup-check-cell">选择</th><th>版本时间</th><th>状态 / 大小</th><th>文件与复用</th></tr></thead><tbody><tr v-for="snapshot in snapshots" :key="snapshot.id" :class="{ selected: selectedSnapshot?.id === snapshot.id }"><td><input type="checkbox" :aria-label="`选择版本${snapshot.id}`" :checked="selectedSnapshots.some(item => item.id === snapshot.id)" :disabled="busy || ['queued', 'running', 'deleting', 'deleted'].includes(snapshot.status)" @change="toggleSnapshot(snapshot, $event)" /></td><td><button class="backup-text-button" type="button" @click="openSnapshot(snapshot.id)">{{ formatDate(snapshot.createdAt) }}</button><small class="backup-muted backup-row-line">配置 v{{ snapshot.planVersion }}</small></td><td><span class="backup-badge" :class="snapshot.status === 'ready' ? 'success' : ['failed', 'uncertain', 'damaged'].includes(snapshot.status) ? 'warning' : ''">{{ SNAPSHOT_STATUS[snapshot.status] }}</span><span class="backup-muted backup-row-line">{{ formatSize(snapshot.totalBytes) }}</span></td><td>{{ snapshot.fileCount }} 文件 · {{ snapshot.directoryCount }} 目录<small class="backup-muted backup-row-line">上传 {{ snapshot.uploadedFiles }} · 复用 {{ snapshot.reusedFiles }}</small></td></tr></tbody></table></div>
    <BackupPager :page="page" :total="total" :busy="listLoading" label="版本" @change="loadSnapshots" />
    <p v-if="selectedSnapshots.length" class="backup-muted">已选择 {{ selectedSnapshots.length }} 个版本，可在“版本清理”中预演其影响。</p>

    <section v-if="selectedSnapshot || detailLoading || detailError" class="backup-subpanel version-detail">
      <div v-if="selectedSnapshot" class="backup-section-heading"><div><h3>{{ formatDate(selectedSnapshot.createdAt) }} 的版本</h3><p class="backup-muted">{{ selectedSnapshot.sourcePath }} · {{ SNAPSHOT_STATUS[selectedSnapshot.status] }}</p></div><button v-if="selectedSnapshot.taskId" class="backup-text-button" type="button" @click="openTask(selectedSnapshot.taskId)">查看备份任务</button></div>
      <p v-if="selectedSnapshot?.error" class="backup-error" role="alert">{{ selectedSnapshot.error }}</p><p v-if="detailError" class="backup-error" role="alert">{{ detailError }}</p><div v-if="detailLoading" class="backup-empty" role="status">正在读取版本目录…</div><BackupFileTable v-else-if="entries.length" :items="entries" :selectable="selectedSnapshot?.status === 'ready'" :selected-paths="selectedPaths" :disabled="busy || restoring || restorePreviewing" @select="selectRestoreEntry" /><div v-else-if="selectedSnapshot && !detailError" class="backup-empty">此版本没有目录条目。</div>
      <BackupPager :page="detailPage" :total="detailTotal" :busy="detailLoading" label="目录" @change="loadSnapshotPage" />
      <div v-if="selectedSnapshot?.status !== 'ready'" class="backup-notice">此版本尚未通过完整校验，当前不能用于恢复。</div>
      <form v-else class="restore-form" @submit.prevent="previewRestore">
        <h3>恢复到本地目录</h3><label class="backup-field">恢复范围<select v-model="restoreScope" aria-label="恢复范围" :disabled="busy || restoring || restorePreviewing"><option value="all">整个版本</option><option value="selected">仅所选文件或目录（{{ selectedPaths.length }} 项）</option></select></label><p v-if="selectedPaths.length" class="backup-muted">跨页已选择 {{ selectedPaths.length }} 项。所选目录包括其全部子项，并保留原相对路径。<button class="backup-text-button" type="button" :disabled="busy || restoring || restorePreviewing" @click="selectedPaths = []">清空条目选择</button></p><p v-if="restoreScope === 'selected' && !selectedPaths.length" class="backup-notice">请在版本目录清单中选择要恢复的文件或目录。</p><div class="backup-path-choice"><span>{{ restorePath || '请选择新的或空的本地目录' }}</span><button class="backup-button" type="button" :disabled="restoring || restorePreviewing || busy || pickingPath" @click="pickRestoreDirectory">选择恢复目录</button></div>
        <label class="backup-checkbox"><input v-model="overwrite" type="checkbox" :disabled="restoring || restorePreviewing || busy" aria-label="允许覆盖恢复目标" />允许覆盖目标中的同名文件，预演后逐项确认</label>
        <p class="backup-muted">默认恢复到新目录或空目录。恢复不会改变备份版本，覆盖模式会在预演中列明同名文件。</p>
        <button class="backup-button" type="submit" :disabled="!restorePath || restoring || restorePreviewing || busy || detailLoading || !!detailError || (restoreScope === 'selected' && !selectedPaths.length)">{{ restorePreviewing ? '正在核对恢复范围…' : '生成恢复预演' }}</button>
      </form>
      <p v-if="restoreError" class="backup-error" role="alert">{{ restoreError }}</p>
      <section v-if="restorePreview" class="restore-preview backup-subpanel">
        <div class="backup-section-heading"><h3>恢复预演</h3><span class="backup-badge" :class="restorePreview.executable ? 'success' : 'warning'">{{ restorePreview.executable ? '可执行' : '不可执行' }}</span></div><p class="backup-path">{{ restorePreview.targetPath }}</p><p class="backup-muted">{{ restorePreview.relativePaths ? `所选 ${restorePreview.relativePaths.length} 项及其子项` : '整个版本' }} · {{ restorePreview.fileCount }} 文件 · {{ restorePreview.directoryCount }} 目录 · {{ formatSize(restorePreview.totalBytes) }} · 覆盖 {{ restorePreview.overwriteCount }} 个文件</p>
        <ul v-if="restorePreview.failures.length" class="backup-warning-list"><li v-for="(failure, index) in restorePreview.failures.slice(0, 100)" :key="index">{{ failure.path }}：{{ failure.error }}</li></ul>
        <div v-if="restorePageLoading" class="backup-empty" role="status">正在读取本页恢复清单…</div><BackupFileTable v-else-if="restoreItems.length" :items="restoreItems" preview /><BackupPager :page="restorePage" :total="restoreTotal" :busy="restorePageLoading || restoring" label="恢复清单" @change="loadRestorePage" />
        <label class="backup-checkbox"><input v-model="restoreConfirmed" type="checkbox" aria-label="确认恢复范围" :disabled="!restorePreview.executable || restoring || busy || restorePageLoading || restoreStale" />我已核对恢复位置和 {{ restorePreview.overwriteCount }} 项覆盖操作</label>
        <button class="backup-button primary" type="button" :disabled="!restoreConfirmed || !restorePreview.executable || restoring || busy || restorePageLoading || restoreStale" @click="executeRestore">{{ restoring ? '正在提交恢复…' : '确认执行恢复' }}</button><p v-if="restoreStale" class="backup-error">此预演已失效，请重新生成恢复预演。</p>
      </section>
    </section>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { formatFileSize } from '@shared/utils'
import type { FileBackupEntry, FileBackupJob, FileBackupResult, FileBackupSnapshot, FileRestorePreview, FileRestorePreviewItem } from '@shared/file-backup'
import { fileBackupsApi } from '../api/file-backups'
import { electronApi } from '../api/ipc'
import BackupPager from './BackupPager.vue'
import BackupFileTable from './BackupFileTable.vue'

const props = defineProps<{ planId: string; busy: boolean; refreshKey: number; requestedSnapshotId?: string; selectedSnapshots: FileBackupSnapshot[] }>()
const emit = defineEmits<{ selection: [snapshots: FileBackupSnapshot[]]; job: [job: FileBackupJob] }>()
const router = useRouter()
const SNAPSHOT_STATUS: Record<FileBackupSnapshot['status'], string> = { queued: '等待备份', running: '备份中', ready: '可恢复', failed: '备份失败', uncertain: '结果待核对', damaged: '版本损坏', deleting: '清理中', deleted: '已清理' }
const snapshots = ref<FileBackupSnapshot[]>([]), page = ref(1), total = ref(0), listLoading = ref(false), listError = ref('')
const selectedSnapshot = ref<FileBackupSnapshot | null>(null), entries = ref<FileBackupEntry[]>([]), detailPage = ref(1), detailTotal = ref(0), detailLoading = ref(false), detailError = ref('')
const restorePath = ref(''), overwrite = ref(false), pickingPath = ref(false), restorePreviewing = ref(false), restoreError = ref(''), restorePreview = ref<FileRestorePreview | null>(null)
const selectedPaths = ref<string[]>([]), restoreScope = ref<'all' | 'selected'>('all')
const restoreItems = ref<FileRestorePreviewItem[]>([]), restorePage = ref(1), restoreTotal = ref(0), restorePageLoading = ref(false), restoreConfirmed = ref(false), restoring = ref(false), restoreStale = ref(false)
const formatSize = formatFileSize
function formatDate(value: number) { return new Date(value).toLocaleString('zh-CN') }
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : String(cause) }
function success<T extends object>(result: FileBackupResult<T>): asserts result is { success: true } & T { if (!result.success) throw new Error(result.error) }
let alive = true, listVersion = 0, selectionVersion = 0, detailVersion = 0, restoreVersion = 0, pathVersion = 0

async function loadSnapshots(targetPage = page.value) {
  const version = ++listVersion; listLoading.value = true; listError.value = ''
  try { const result = await fileBackupsApi.listSnapshots({ planId: props.planId, page: targetPage, pageSize: 50 }); if (!alive || version !== listVersion) return; success(result); total.value = result.total; const last = Math.max(1, Math.ceil(result.total / 50)); if (targetPage > last) { await loadSnapshots(last); return }; snapshots.value = result.snapshots; page.value = result.page }
  catch (cause) { if (alive && version === listVersion) listError.value = errorText(cause) }
  finally { if (alive && version === listVersion) listLoading.value = false }
}
function toggleSnapshot(snapshot: FileBackupSnapshot, event: Event) { const next = props.selectedSnapshots.filter(item => item.id !== snapshot.id); if ((event.target as HTMLInputElement).checked) next.push(snapshot); emit('selection', next) }
function invalidateRestore() { restoreVersion++; restorePreview.value = null; restoreItems.value = []; restoreConfirmed.value = false; restoreStale.value = false; restorePageLoading.value = false; restorePreviewing.value = false; restoreError.value = '' }
async function openSnapshot(id: string) { selectionVersion++; detailVersion++; pathVersion++; pickingPath.value = false; selectedSnapshot.value = null; entries.value = []; selectedPaths.value = []; restoreScope.value = 'all'; detailTotal.value = 0; restorePath.value = ''; overwrite.value = false; invalidateRestore(); await loadSnapshot(id, 1) }
function selectRestoreEntry(relativePath: string, selected: boolean) { if (props.busy || restoring.value || restorePreviewing.value) return; selectedPaths.value = selectedPaths.value.filter(item => item !== relativePath); if (selected) { selectedPaths.value.push(relativePath); restoreScope.value = 'selected' } }
async function loadSnapshot(id: string, targetPage: number) {
  const version = ++detailVersion; detailLoading.value = true; detailError.value = ''
  try { const result = await fileBackupsApi.getSnapshot({ snapshotId: id, page: targetPage, pageSize: 50 }); if (!alive || version !== detailVersion) return; success(result); selectedSnapshot.value = result.snapshot; detailTotal.value = result.total; const last = Math.max(1, Math.ceil(result.total / 50)); if (targetPage > last) { await loadSnapshot(id, last); return }; entries.value = result.entries; detailPage.value = result.page }
  catch (cause) { if (alive && version === detailVersion) { detailError.value = errorText(cause); entries.value = [] } }
  finally { if (alive && version === detailVersion) detailLoading.value = false }
}
function loadSnapshotPage(targetPage: number) { if (selectedSnapshot.value) void loadSnapshot(selectedSnapshot.value.id, targetPage) }
async function pickRestoreDirectory() {
  if (restoring.value || props.busy || pickingPath.value) return
  const version = ++pathVersion, selection = selectionVersion; pickingPath.value = true
  try { const result = await electronApi.showOpenDialog({ title: '选择新的或空的恢复目录', properties: ['openDirectory', 'createDirectory'] }); if (!alive || version !== pathVersion || selection !== selectionVersion) return; if (!result.canceled && result.filePaths?.[0]) restorePath.value = result.filePaths[0] }
  catch (cause) { if (alive && version === pathVersion) restoreError.value = errorText(cause) }
  finally { if (alive && version === pathVersion) pickingPath.value = false }
}
async function previewRestore() {
  const snapshot = selectedSnapshot.value; if (!snapshot || snapshot.status !== 'ready' || !restorePath.value || props.busy || restoring.value || restorePreviewing.value || (restoreScope.value === 'selected' && !selectedPaths.value.length)) return
  const version = ++restoreVersion, selection = selectionVersion; restorePreviewing.value = true; restoreError.value = ''; restorePreview.value = null; restoreConfirmed.value = false
  try { const result = await fileBackupsApi.previewRestore({ snapshotId: snapshot.id, targetPath: restorePath.value, overwrite: overwrite.value, ...(restoreScope.value === 'selected' ? { relativePaths: [...selectedPaths.value] } : {}) }); success(result); if (!alive || version !== restoreVersion || selection !== selectionVersion) return; restorePreview.value = result.preview; restoreStale.value = false; restorePreviewing.value = false; await loadRestorePage(1) }
  catch (cause) { if (alive && version === restoreVersion) restoreError.value = errorText(cause) }
  finally { if (alive && version === restoreVersion) restorePreviewing.value = false }
}
async function loadRestorePage(targetPage: number) {
  const current = restorePreview.value; if (!current) return
  const version = ++restoreVersion; restorePageLoading.value = true; restoreConfirmed.value = false
  try { const result = await fileBackupsApi.getRestorePreview({ previewId: current.id, page: targetPage, pageSize: 50 }); if (!alive || version !== restoreVersion) return; success(result); restorePreview.value = result.preview; restoreTotal.value = result.total; const last = Math.max(1, Math.ceil(result.total / 50)); if (targetPage > last) { await loadRestorePage(last); return }; restoreItems.value = result.items; restorePage.value = result.page; restoreError.value = '' }
  catch (cause) { if (alive && version === restoreVersion) { restoreError.value = errorText(cause); restoreItems.value = []; restoreStale.value = true } }
  finally { if (alive && version === restoreVersion) restorePageLoading.value = false }
}
async function executeRestore() {
  const current = restorePreview.value; if (!current?.executable || !restoreConfirmed.value || restoring.value || props.busy || restoreStale.value || restorePageLoading.value) return
  const selection = selectionVersion; restoring.value = true; restoreError.value = ''
  try { const result = await fileBackupsApi.executeRestore(current.id); success(result); if (!alive || selection !== selectionVersion) return; restoreConfirmed.value = false; emit('job', result.job) }
  catch (cause) { if (alive && selection === selectionVersion) { restoreError.value = errorText(cause); restoreStale.value = true; restoreConfirmed.value = false } }
  finally { if (alive) restoring.value = false }
}
function openTask(id: string) { void router.push({ path: '/tasks', query: { taskId: id, from: 'file-backups' } }) }
watch([restorePath, overwrite, restoreScope, selectedPaths], invalidateRestore, { flush: 'sync' })
watch(() => props.refreshKey, () => { void loadSnapshots(); if (selectedSnapshot.value) void loadSnapshot(selectedSnapshot.value.id, detailPage.value) })
watch(() => props.requestedSnapshotId, value => { if (value) void openSnapshot(value) })
onMounted(() => { void loadSnapshots(); if (props.requestedSnapshotId) void openSnapshot(props.requestedSnapshotId) })
onBeforeUnmount(() => { alive = false; listVersion++; detailVersion++; restoreVersion++; selectionVersion++; pathVersion++ })
</script>
